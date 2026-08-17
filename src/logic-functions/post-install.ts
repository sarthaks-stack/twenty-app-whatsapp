import { definePostInstallLogicFunction } from 'twenty-sdk/define';
import { kv, type InstallPayload } from 'twenty-sdk/logic-function';

import {
  LF_POST_INSTALL,
  LF_WEBHOOK_RESOLVER,
  ROLE_ADMIN,
  ROLE_AGENT,
} from '../constants/universal-identifiers';
import { ACCOUNT_STATUS, REQUIRED_WEBHOOK_FIELDS } from '../domain/constants';
import { metadataClient } from '../server/clients';
import { describeError, logger } from '../server/logger';
import { listAccounts } from '../server/repositories/accounts';
import { currentWorkspaceId } from '../server/workspace';
import {
  phoneClaimKey,
  readClaimOwners,
  wabaClaimKey,
} from './wa-account-admin-route';

/**
 * Post-install (AR-5, specs/01 §5).
 *
 * It runs on first install *and* on every version upgrade, so everything it
 * does has to be idempotent — and it deliberately does very little. In
 * particular it **does not invent a `whatsappAccount`**: an account carries the
 * routing claim for a real phone number, and a seeded placeholder would either
 * be useless or claim a number nobody authorised.
 *
 * What it is for is the two things an operator cannot discover on their own:
 * the callback URL to paste into Meta, and whether anything about this install
 * is already wrong.
 */

/**
 * Bumped only when an upgrade needs a data backfill.
 *
 * The marker is written on every run, so the *value* is what makes a
 * version-gated migration possible later: a future release reads it, sees `1`,
 * runs the migration, and writes `2`. There are no backfills today, and the
 * marker exists precisely so the first one does not have to guess what state it
 * is starting from.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_VERSION_KEY = 'wa:schema-version';

export type PostInstallResult = {
  previousVersion: string | null;
  newVersion: string;
  firstInstall: boolean;
  schemaVersion: number;
  rolesPresent: string[];
  rolesMissing: string[];
  accounts: number;
  claimsRepaired: number;
  claimsConflicting: number;
  callbackUrl: string | null;
};

/**
 * The two app roles, checked rather than created.
 *
 * They are declared in the manifest, so Twenty applies them — this is a *smoke
 * test of the manifest*, not a seeding step. A missing role is logged as an
 * error because it means an install that will refuse every admin action, and
 * the alternative is discovering it when someone tries to connect a number.
 */
const checkRoles = async (): Promise<{ present: string[]; missing: string[] }> => {
  const expected = [
    { id: ROLE_ADMIN, name: 'WhatsApp Admin' },
    { id: ROLE_AGENT, name: 'WhatsApp Agent' },
  ];

  try {
    const result = await metadataClient().query({
      getRoles: { universalIdentifier: true },
    });

    const found = new Set(
      (result.getRoles ?? [])
        .map((role) => role.universalIdentifier)
        .filter((identifier): identifier is string => typeof identifier === 'string'),
    );

    return {
      present: expected.filter((role) => found.has(role.id)).map((role) => role.name),
      missing: expected.filter((role) => !found.has(role.id)).map((role) => role.name),
    };
  } catch (error) {
    /**
     * Not fatal. A metadata read that fails must not abort an install — the
     * roles are applied by the platform either way, and a post-install hook
     * that throws leaves an app installed with an error nobody can act on.
     */
    logger.warn('wa.install.role_check_failed', describeError(error));

    return { present: [], missing: [] };
  }
};

/**
 * Re-asserts the routing claim for every already-connected number.
 *
 * The claim is a SERVER-scoped `kv` entry, and it is the only thing that tells
 * the webhook resolver which workspace a delivery belongs to. A restore, a
 * migration between instances, or a manually cleared key leaves an account
 * record that looks perfectly healthy while every message for that number is
 * discarded as unclaimed — the exact failure `whatsappAccount.isUICreatable:
 * false` exists to prevent, arriving by a different route.
 *
 * A claim held by **another** workspace is never touched, only reported. Taking
 * it would silently divert that tenant's inbound traffic here, which is the one
 * thing worse than a missing claim (SEC-5).
 */
const repairClaims = async (
  workspaceId: string,
): Promise<{ repaired: number; conflicting: number; accounts: number }> => {
  const accounts = await listAccounts([ACCOUNT_STATUS.CONNECTED]);

  let repaired = 0;
  let conflicting = 0;

  for (const account of accounts) {
    const phoneNumberId = account.phoneNumberId;
    const wabaId = account.wabaId;

    if (typeof phoneNumberId !== 'string' || typeof wabaId !== 'string') continue;

    const owners = await readClaimOwners({ phoneNumberId, wabaId });

    if (
      (owners.phone !== null && owners.phone !== workspaceId) ||
      (owners.waba !== null && owners.waba !== workspaceId)
    ) {
      conflicting += 1;
      logger.error('wa.install.claim_conflict', {
        accountId: account.id,
        phoneNumberId,
        wabaId,
      });

      continue;
    }

    if (owners.phone === null) {
      await kv.set(phoneClaimKey(phoneNumberId), workspaceId, { scope: 'SERVER' });
      repaired += 1;
    }

    if (owners.waba === null) {
      await kv.set(wabaClaimKey(wabaId), workspaceId, { scope: 'SERVER' });
      repaired += 1;
    }
  }

  return { repaired, conflicting, accounts: accounts.length };
};

export const install = async (payload: InstallPayload): Promise<PostInstallResult> => {
  const log = logger.child({ fn: 'post-install' });

  const previous = await kv.get<number>(SCHEMA_VERSION_KEY, { scope: 'WORKSPACE' });
  const firstInstall = typeof previous !== 'number';

  const roles = await checkRoles();

  if (roles.missing.length > 0) {
    log.error('wa.install.roles_missing', { missing: roles.missing });
  }

  const workspaceId = await currentWorkspaceId();

  let claims = { repaired: 0, conflicting: 0, accounts: 0 };

  if (workspaceId === null) {
    log.error('wa.install.no_workspace_id');
  } else {
    try {
      claims = await repairClaims(workspaceId);
    } catch (error) {
      log.warn('wa.install.claim_repair_failed', describeError(error));
    }
  }

  await kv.set(SCHEMA_VERSION_KEY, SCHEMA_VERSION, { scope: 'WORKSPACE' });

  const base = (process.env.TWENTY_API_URL ?? '').replace(/\/+$/, '');
  const callbackUrl = base === '' ? null : `${base}/s/whatsapp/webhook`;

  /**
   * The one thing an operator cannot work out for themselves.
   *
   * The Meta callback URL contains the webhook resolver's universal identifier,
   * which appears nowhere in the product UI. Printing it here — with the direct
   * form beside the alias, and the field list — means the function log is a
   * complete answer to "what do I paste into the App Dashboard", which is the
   * step every install gets stuck on.
   *
   * The verify token is *not* printed. It is a secret, and a value in a log is
   * a value in the next support ticket.
   */
  const result: PostInstallResult = {
    previousVersion: payload.previousVersion ?? null,
    newVersion: payload.newVersion,
    firstInstall,
    schemaVersion: SCHEMA_VERSION,
    rolesPresent: roles.present,
    rolesMissing: roles.missing,
    accounts: claims.accounts,
    claimsRepaired: claims.repaired,
    claimsConflicting: claims.conflicting,
    callbackUrl,
  };

  log.info('wa.install.completed', {
    ...result,
    directCallbackUrl: base === '' ? null : `${base}/webhooks/server/${LF_WEBHOOK_RESOLVER}`,
    verifyUrl: base === '' ? null : `${base}/s/whatsapp/verify`,
    verifyTokenConfigured: (process.env.META_VERIFY_TOKEN ?? '').length > 0,
    requiredWebhookFields: [...REQUIRED_WEBHOOK_FIELDS],
    /**
     * Nobody is assigned to a role here, and that is not an omission. The
     * install payload carries versions and no user, so "the installing user"
     * is not knowable — and it does not need to be: `requireCaller` already
     * treats any Twenty workspace administrator as a WhatsApp admin, so the
     * person who installed the app can connect a number immediately. The
     * explicit roles exist to grant reps access *without* making them
     * workspace administrators.
     */
    rolesNote:
      'Assign WhatsApp Agent to reps in Settings → Members. Workspace administrators already have WhatsApp admin authority.',
  });

  return result;
};

export default definePostInstallLogicFunction({
  universalIdentifier: LF_POST_INSTALL,
  name: 'post-install',
  description:
    'Verifies the app roles, repairs webhook routing claims, records the schema version and logs the Meta callback URL.',
  timeoutSeconds: 60,
  shouldRunOnVersionUpgrade: true,
  /**
   * Asynchronous: nothing here gates the app being usable, and a synchronous
   * hook makes every upgrade wait on a metadata read and a claim sweep.
   */
  shouldRunSynchronously: false,
  handler: install,
});
