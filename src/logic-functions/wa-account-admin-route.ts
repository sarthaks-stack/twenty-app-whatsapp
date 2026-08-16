import { defineLogicFunction } from 'twenty-sdk/define';
import { Response, kv, type RoutePayload } from 'twenty-sdk/logic-function';

import { LF_ACCOUNT_ADMIN_ROUTE } from '../constants/universal-identifiers';
import {
  ACCOUNT_STATUS,
  MESSAGING_TIER,
  QUALITY,
  type MessagingTier,
  type Quality,
} from '../domain/constants';
import { getProvider } from '../providers/whatsapp';
import { MetaApiError } from '../providers/whatsapp/errors';
import { AUDIT_ACTION, audit } from '../server/audit';
import { authErrorResponse, requireCaller, requireRole } from '../server/auth';
import { describeError, logger } from '../server/logger';
import { currentWorkspaceId } from '../server/workspace';
import { syncAccount } from './wa-template-sync';
import { nodesOf, query } from '../server/repositories/base';
import {
  findAccountByPhoneNumberId,
  findAccountById,
  patchAccount,
  type WhatsappAccountRecord,
} from '../server/repositories/accounts';

/**
 * Account connect / test / disconnect (FR-ACC-1, FR-ACC-6, D-3, SEC-5).
 *
 * `whatsappAccount` is `isUICreatable: false` precisely so this route is the
 * only way an account comes into existence. The reason is the **kv routing
 * claim**: the webhook resolver runs in the app-owner workspace and can only
 * find the owning workspace through `wa:phone-number:{id}`. A record created by
 * hand in the UI would have no claim, so every message for that number would be
 * answered "unclaimed" and silently discarded — with a perfectly healthy-looking
 * account record sitting in the CRM.
 *
 * Writing the claim and the record together, here, is what makes that
 * impossible.
 */

export type AccountAction = 'connect' | 'test' | 'disconnect' | 'list' | 'syncTemplates';

export type AccountRouteBody = {
  action?: AccountAction;
  accountId?: string;
  name?: string;
  wabaId?: string;
  phoneNumberId?: string;
  defaultCountryCallingCode?: string;
  isTestAccount?: boolean;
  contactAutoCreationEnabled?: boolean;
  sendThrottlePerSecond?: number;
  /** Ask Meta to start delivering this WABA's events to us (appendix A §1). */
  subscribeApp?: boolean;
};

const QUALITY_FROM_META: Record<string, Quality> = {
  GREEN: QUALITY.GREEN,
  YELLOW: QUALITY.YELLOW,
  RED: QUALITY.RED,
  UNKNOWN: QUALITY.UNKNOWN,
};

const TIER_FROM_META: Record<string, MessagingTier> = {
  TIER_250: MESSAGING_TIER.TIER_250,
  TIER_1K: MESSAGING_TIER.TIER_1K,
  TIER_2K: MESSAGING_TIER.TIER_2K,
  TIER_10K: MESSAGING_TIER.TIER_10K,
  TIER_100K: MESSAGING_TIER.TIER_100K,
  TIER_UNLIMITED: MESSAGING_TIER.TIER_UNLIMITED,
};

export const phoneClaimKey = (phoneNumberId: string): string =>
  `wa:phone-number:${phoneNumberId}`;

export const wabaClaimKey = (wabaId: string): string => `wa:waba:${wabaId}`;

/**
 * Both claims are written, not just the phone one.
 *
 * Template and account webhooks carry no `phone_number_id` at all — only the
 * WABA id on the entry — so an account with just the phone claim would receive
 * messages and silently lose every template approval (D-3).
 */
export const writeClaims = async ({
  workspaceId,
  phoneNumberId,
  wabaId,
}: {
  workspaceId: string;
  phoneNumberId: string;
  wabaId: string;
}): Promise<void> => {
  await kv.set(phoneClaimKey(phoneNumberId), workspaceId, { scope: 'SERVER' });
  await kv.set(wabaClaimKey(wabaId), workspaceId, { scope: 'SERVER' });
};

/**
 * The WABA claim is *not* cleared on disconnect when another connected account
 * still shares that WABA — several numbers commonly live under one business
 * account, and clearing it would break the others' template events.
 */
export const clearClaims = async ({
  phoneNumberId,
  wabaId,
  wabaStillInUse,
}: {
  phoneNumberId: string;
  wabaId: string;
  wabaStillInUse: boolean;
}): Promise<void> => {
  await kv.delete(phoneClaimKey(phoneNumberId), { scope: 'SERVER' });

  if (!wabaStillInUse) await kv.delete(wabaClaimKey(wabaId), { scope: 'SERVER' });
};

const ACCOUNT_SUMMARY = {
  id: true,
  name: true,
  phoneNumberId: true,
  wabaId: true,
  displayPhoneNumber: true,
  displayName: true,
  status: true,
  statusDetail: true,
  qualityRating: true,
  messagingLimitTier: true,
  webhookLastEventAt: true,
  webhookLastVerifiedAt: true,
  tokenLastCheckedAt: true,
  isTestAccount: true,
} as const;

const countOtherAccountsOnWaba = async (
  wabaId: string,
  excludeAccountId: string,
): Promise<number> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappAccounts: {
          __args: { filter: { wabaId: { eq: wabaId } }, first: 10 },
          edges: { node: { id: true, status: true } },
        },
      }),
    'accounts.countOnWaba',
  );

  return nodesOf<{ id: string; status?: string | null }>(result.whatsappAccounts).filter(
    (account) => account.id !== excludeAccountId && account.status !== ACCOUNT_STATUS.DISABLED,
  ).length;
};

/** A live `GET /{phone_number_id}`, which is the only real proof of a connection. */
const probeNumber = async (
  accountId: string,
  phoneNumberId: string,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> => {
  try {
    const number = await getProvider().getPhoneNumber(phoneNumberId);

    await patchAccount(accountId, {
      status: ACCOUNT_STATUS.CONNECTED,
      statusDetail: null,
      displayPhoneNumber: number.displayPhoneNumber,
      displayName: number.verifiedName,
      qualityRating: QUALITY_FROM_META[(number.qualityRating ?? '').toUpperCase()] ?? QUALITY.UNKNOWN,
      ...(TIER_FROM_META[(number.messagingLimitTier ?? '').toUpperCase()] === undefined
        ? {}
        : {
            messagingLimitTier: TIER_FROM_META[
              (number.messagingLimitTier ?? '').toUpperCase()
            ]!,
          }),
      tokenLastCheckedAt: new Date().toISOString(),
    });

    return { ok: true, detail: number.verifiedName ?? number.displayPhoneNumber ?? phoneNumberId };
  } catch (error) {
    const detail =
      error instanceof MetaApiError
        ? `${error.code ?? error.httpStatus ?? 'error'}: ${error.details ?? error.message}`
        : String(error);

    /**
     * A failed probe marks the account `ERROR` rather than deleting it. The
     * record and its claim stay, so a token fixed an hour later resumes
     * delivery without re-entering anything — and the webhook events that
     * arrived meanwhile were still recorded.
     */
    await patchAccount(accountId, {
      status: ACCOUNT_STATUS.ERROR,
      statusDetail: detail.slice(0, 500),
      tokenLastCheckedAt: new Date().toISOString(),
    });

    return { ok: false, detail };
  }
};

export const handler = async (
  event: RoutePayload<AccountRouteBody>,
): Promise<Response> => {
  const log = logger.child({ fn: 'wa-account-admin-route' });

  try {
    const caller = await requireCaller(event);
    requireRole(caller, 'admin');

    const body = event.body ?? {};
    const action = body.action ?? 'list';

    switch (action) {
      case 'list': {
        const result = await query(
          (client) =>
            client.query({
              whatsappAccounts: {
                __args: { first: 60 },
                edges: { node: ACCOUNT_SUMMARY },
              },
            }),
          'accounts.listSummary',
        );

        return new Response(
          { accounts: nodesOf<WhatsappAccountRecord>(result.whatsappAccounts) },
          { status: 200 },
        );
      }

      case 'connect': {
        const phoneNumberId = (body.phoneNumberId ?? '').trim();
        const wabaId = (body.wabaId ?? '').trim();

        if (phoneNumberId.length === 0 || wabaId.length === 0) {
          return new Response(
            { error: 'phoneNumberId and wabaId are required' },
            { status: 400 },
          );
        }

        /**
         * Deliberately *not* `event.userWorkspaceId`, which is the membership
         * id. The resolver dispatches on the value stored here, so a membership
         * id would route every delivery to nowhere — and both are UUIDs, so
         * nothing would complain.
         */
        const workspaceId = await currentWorkspaceId();

        if (workspaceId === null) {
          log.error('wa.account.no_workspace_id');

          return new Response(
            { error: 'Could not determine the workspace for the routing claim' },
            { status: 500 },
          );
        }

        const existing = await findAccountByPhoneNumberId(phoneNumberId);

        const account: WhatsappAccountRecord | null =
          existing ??
          (await query(
            (client) =>
              client.mutation({
                createWhatsappAccount: {
                  __args: {
                    data: {
                      name: body.name ?? `WhatsApp ${phoneNumberId}`,
                      phoneNumberId,
                      wabaId,
                      status: ACCOUNT_STATUS.PENDING,
                      ...(body.defaultCountryCallingCode === undefined
                        ? {}
                        : { defaultCountryCallingCode: body.defaultCountryCallingCode }),
                      ...(body.isTestAccount === undefined
                        ? {}
                        : { isTestAccount: body.isTestAccount }),
                      ...(body.contactAutoCreationEnabled === undefined
                        ? {}
                        : { contactAutoCreationEnabled: body.contactAutoCreationEnabled }),
                      ...(body.sendThrottlePerSecond === undefined
                        ? {}
                        : { sendThrottlePerSecond: body.sendThrottlePerSecond }),
                    },
                  },
                  ...ACCOUNT_SUMMARY,
                },
              }),
            'accounts.create',
          ).then((result) => (result.createWhatsappAccount ?? null) as WhatsappAccountRecord | null));

        if (account === null) {
          log.error('wa.account.create_returned_nothing', { phoneNumberId });

          return new Response({ error: 'Could not create the account record' }, { status: 500 });
        }

        // The claim goes down before the probe: a token that fails today must
        // not leave a number whose webhooks are discarded as unclaimed.
        await writeClaims({ workspaceId, phoneNumberId, wabaId });

        const probe = await probeNumber(account.id, phoneNumberId);

        /**
         * Subscribing the app to the WABA is the step whose absence is
         * invisible: the dashboard shows the webhook verified, active and every
         * field subscribed, the Test button works, and real messages are
         * discarded with no error anywhere. Confirmed 2026-08-15.
         */
        let subscribed: boolean | null = null;

        if (body.subscribeApp !== false) {
          try {
            await getProvider().subscribeApp(wabaId);
            subscribed = true;
          } catch (error) {
            subscribed = false;
            log.warn('wa.account.subscribe_failed', {
              accountId: account.id,
              ...describeError(error),
            });
          }
        }

        audit({
          action: AUDIT_ACTION.ACCOUNT_CONNECT,
          actorId: caller.workspaceMemberId,
          subject: { accountId: account.id },
          details: { phoneNumberId, wabaId, probeOk: probe.ok, subscribed },
        });

        return new Response(
          {
            accountId: account.id,
            created: existing === null,
            connection: probe,
            subscribedApp: subscribed,
          },
          { status: probe.ok ? 200 : 502 },
        );
      }

      case 'test': {
        const account =
          body.accountId === undefined ? null : await findAccountById(body.accountId);

        if (account === null || typeof account.phoneNumberId !== 'string') {
          return new Response({ error: 'Unknown account' }, { status: 404 });
        }

        const probe = await probeNumber(account.id, account.phoneNumberId);

        return new Response({ connection: probe }, { status: probe.ok ? 200 : 502 });
      }

      case 'disconnect': {
        const account =
          body.accountId === undefined ? null : await findAccountById(body.accountId);

        const phoneNumberId = account?.phoneNumberId;
        const wabaId = account?.wabaId;

        if (
          account === null ||
          typeof phoneNumberId !== 'string' ||
          typeof wabaId !== 'string'
        ) {
          return new Response({ error: 'Unknown account' }, { status: 404 });
        }

        const others = await countOtherAccountsOnWaba(wabaId, account.id);

        await clearClaims({ phoneNumberId, wabaId, wabaStillInUse: others > 0 });

        /**
         * Disabled, not deleted. The conversations, messages and campaign
         * history belong to the CRM, and a disconnect is an operational action
         * — deleting a number's account would cascade away a year of customer
         * correspondence.
         */
        await patchAccount(account.id, {
          status: ACCOUNT_STATUS.DISABLED,
          statusDetail: 'disconnected',
        });

        audit({
          action: AUDIT_ACTION.ACCOUNT_DISCONNECT,
          actorId: caller.workspaceMemberId,
          subject: { accountId: account.id },
          details: { wabaClaimKept: others > 0 },
        });

        return new Response({ accountId: account.id, wabaClaimKept: others > 0 }, { status: 200 });
      }

      /**
       * The settings panel's "Sync now" (specs/06 §1).
       *
       * It lives here rather than as a second trigger on `wa-template-sync`
       * because that function is a cron worker returning a result object, and
       * an HTTP route has to return a `Response` — one function cannot sensibly
       * be both. The settings page is already talking to this route about this
       * account, so the action belongs where the operator already is.
       */
      case 'syncTemplates': {
        const account =
          body.accountId === undefined ? null : await findAccountById(body.accountId);

        if (account === null) {
          return new Response({ error: 'Unknown account' }, { status: 404 });
        }

        const result = await syncAccount(account);

        return new Response(result, { status: result.error === undefined ? 200 : 502 });
      }

      default:
        return new Response({ error: `Unknown action: ${String(action)}` }, { status: 400 });
    }
  } catch (error) {
    const authFailure = authErrorResponse(error);

    if (authFailure !== null) {
      return new Response(authFailure.body, { status: authFailure.status });
    }

    log.error('wa.account.route_failed', describeError(error));

    return new Response({ error: 'Internal error' }, { status: 500 });
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_ACCOUNT_ADMIN_ROUTE,
  name: 'wa-account-admin-route',
  description:
    'Connects, tests and disconnects WhatsApp numbers, writing the workspace routing claim.',
  timeoutSeconds: 30,
  httpRouteTriggerSettings: {
    path: '/whatsapp/account',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
