import { defineUninstallLogicFunction } from 'twenty-sdk/define';
import { kv, type UninstallPayload } from 'twenty-sdk/logic-function';

import { LF_UNINSTALL } from '../constants/universal-identifiers';
import { describeError, logger } from '../server/logger';
import { listAccounts } from '../server/repositories/accounts';
import { currentWorkspaceId } from '../server/workspace';
import {
  phoneClaimKey,
  readClaimOwners,
  wabaClaimKey,
} from './wa-account-admin-route';

/**
 * Uninstall (AR-5, specs/01 §5).
 *
 * Two rules, and they pull in opposite directions on purpose.
 *
 * **Release every routing claim.** The claims are SERVER-scoped `kv` entries
 * shared across every workspace on the instance, and they outlive the app: a
 * number left claimed by an uninstalled app cannot be connected anywhere,
 * including here after a reinstall, and nothing in any UI would say why. This
 * mirrors what Twenty's own Slack integration does on disconnect.
 *
 * **Destroy nothing.** Conversations, messages, consent evidence and campaign
 * history stay exactly where they are. Uninstalling an app is not a decision to
 * delete a year of customer correspondence, and deletion has its own deliberate,
 * audited route (SEC-8). A reinstall finds the records intact.
 *
 * `kv` has no scan, so the claims cannot be enumerated — they are reconstructed
 * from the account records, which is the only reason those records have to be
 * read before anything is released.
 */

export type UninstallResult = {
  version: string | null;
  accounts: number;
  released: number;
  /** Claims left alone because another workspace holds them. */
  foreign: number;
};

export const uninstall = async (payload: UninstallPayload): Promise<UninstallResult> => {
  const log = logger.child({ fn: 'uninstall' });

  const result: UninstallResult = {
    version: payload.version ?? null,
    accounts: 0,
    released: 0,
    foreign: 0,
  };

  const workspaceId = await currentWorkspaceId();

  /**
   * Without the workspace id there is no way to tell our claims from another
   * tenant's, and deleting on a guess would silence someone else's number. So
   * the hook gives up loudly and leaves the claims in place: a stranded claim is
   * repaired by the next install (post-install re-asserts it), while a stolen
   * one is an incident.
   */
  if (workspaceId === null) {
    log.error('wa.uninstall.no_workspace_id');

    return result;
  }

  let accounts;

  try {
    accounts = await listAccounts();
  } catch (error) {
    log.error('wa.uninstall.accounts_unreadable', describeError(error));

    return result;
  }

  result.accounts = accounts.length;

  for (const account of accounts) {
    const phoneNumberId = account.phoneNumberId;
    const wabaId = account.wabaId;

    if (typeof phoneNumberId !== 'string' || typeof wabaId !== 'string') continue;

    try {
      const owners = await readClaimOwners({ phoneNumberId, wabaId });

      /**
       * Owner-checked, one key at a time. A local record whose Meta ids happen
       * to match another tenant's connected number must not silence them.
       *
       * Unlike `disconnect`, the WABA claim is released even when other accounts
       * share it — every account in this workspace is going away together, so
       * "still in use" can only mean used by a workspace that is not ours, and
       * that case is already excluded by the owner check.
       */
      if (owners.phone === workspaceId) {
        await kv.delete(phoneClaimKey(phoneNumberId), { scope: 'SERVER' });
        result.released += 1;
      } else if (owners.phone !== null) {
        result.foreign += 1;
      }

      if (owners.waba === workspaceId) {
        await kv.delete(wabaClaimKey(wabaId), { scope: 'SERVER' });
        result.released += 1;
      } else if (owners.waba !== null) {
        result.foreign += 1;
      }
    } catch (error) {
      /**
       * One account's failure must not strand the rest. An unreleased claim is
       * recoverable — the operator clears it, or a reinstall re-asserts it — but
       * abandoning the loop would leave every later number claimed too.
       */
      log.warn('wa.uninstall.claim_release_failed', {
        accountId: account.id,
        ...describeError(error),
      });
    }
  }

  log.warn('wa.uninstall.completed', {
    ...result,
    recordsKept:
      'Conversations, messages, consent events and campaigns are left in place. Deleting them is a separate, audited action.',
  });

  return result;
};

export default defineUninstallLogicFunction({
  universalIdentifier: LF_UNINSTALL,
  name: 'uninstall',
  description:
    'Releases this workspace’s WhatsApp routing claims so the numbers can be connected again, and leaves every record in place.',
  timeoutSeconds: 60,
  handler: uninstall,
});
