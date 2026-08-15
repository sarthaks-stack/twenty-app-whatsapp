import { defineLogicFunction } from 'twenty-sdk/define';

import { LF_ACCOUNT_EVENT } from '../constants/universal-identifiers';
import {
  ACCOUNT_STATUS,
  MESSAGING_TIER,
  QUALITY,
  type MessagingTier,
  type Quality,
} from '../domain/constants';
import type { MetaChangeValue } from '../domain/webhook/types';
import { logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import {
  findAccountById,
  patchAccount,
  type AccountPatch,
} from '../server/repositories/accounts';
import { markWebhookEvent, markWebhookEventFailed } from '../server/repositories/webhook-events';

/**
 * Account and phone-number events (FR-ACC-3).
 *
 * The consequences are wired here rather than in the UI, because they must hold
 * for a workflow-driven send and a campaign runner at 3am as much as for a rep
 * looking at a banner.
 *
 * The important asymmetry: a RED quality rating pauses **campaigns**, not 1:1
 * messaging. A rep must still be able to answer a customer who wrote in — that
 * is precisely the traffic that recovers a rating, and blocking it would turn a
 * warning into an outage.
 */

export type AccountEventPayload = {
  webhookEventId?: string;
  accountId: string;
  field: string;
  value: MetaChangeValue;
};

export type AccountEventResult = {
  outcome: 'patched' | 'ignored';
  qualityChanged?: boolean;
  restricted?: boolean;
};

const QUALITY_FROM_EVENT: Record<string, Quality> = {
  GREEN: QUALITY.GREEN,
  YELLOW: QUALITY.YELLOW,
  RED: QUALITY.RED,
  FLAGGED: QUALITY.RED,
  UNFLAGGED: QUALITY.GREEN,
  ONBOARDING: QUALITY.UNKNOWN,
  UNKNOWN: QUALITY.UNKNOWN,
};

const TIER_FROM_LIMIT: Record<string, MessagingTier> = {
  TIER_250: MESSAGING_TIER.TIER_250,
  TIER_1K: MESSAGING_TIER.TIER_1K,
  TIER_2K: MESSAGING_TIER.TIER_2K,
  TIER_10K: MESSAGING_TIER.TIER_10K,
  TIER_100K: MESSAGING_TIER.TIER_100K,
  TIER_UNLIMITED: MESSAGING_TIER.TIER_UNLIMITED,
};

/**
 * Events that mean the number is out of service, not merely degraded. Meta's
 * naming is inconsistent across payloads, so this matches on substrings rather
 * than an exact set — a new variant of "restricted" must fail safe by matching,
 * not fail open by being unrecognised.
 */
const isRestrictionEvent = (event: string): boolean =>
  /VIOLATION|RESTRICTION|BANNED|DISABLED|ACCOUNT_DELETED/i.test(event);

export const processAccountEvent = async (
  payload: AccountEventPayload,
): Promise<AccountEventResult> => {
  const { field, value } = payload;
  const log = logger.child({ fn: 'wa-account-event', accountId: payload.accountId });

  const account = await findAccountById(payload.accountId);

  if (account === null) {
    log.error('wa.account.unknown');

    return { outcome: 'ignored' };
  }

  const patch: AccountPatch = {};
  let qualityChanged = false;
  let restricted = false;

  switch (field) {
    case 'phone_number_quality_update': {
      const quality = QUALITY_FROM_EVENT[(value.event ?? '').toUpperCase()];

      if (quality !== undefined && quality !== account.qualityRating) {
        patch.qualityRating = quality;
        qualityChanged = true;
        count(METRIC.ACCOUNT_QUALITY_CHANGE);
      }

      const tier = TIER_FROM_LIMIT[(value.current_limit ?? '').toUpperCase()];
      if (tier !== undefined) patch.messagingLimitTier = tier;

      if (typeof value.display_phone_number === 'string') {
        patch.displayPhoneNumber = value.display_phone_number;
      }
      break;
    }

    case 'account_update': {
      const event = (value.event ?? '').toUpperCase();

      if (isRestrictionEvent(event)) {
        patch.status = ACCOUNT_STATUS.ERROR;
        patch.statusDetail = describeRestriction(value);
        restricted = true;
        count(METRIC.ACCOUNT_RESTRICTED);
      } else if (event === 'VERIFIED_ACCOUNT' && account.status === ACCOUNT_STATUS.ERROR) {
        /**
         * Recovery is not automatic beyond clearing the error: an admin should
         * see the account come back rather than have a send silently resume
         * mid-incident.
         */
        patch.status = ACCOUNT_STATUS.CONNECTED;
        patch.statusDetail = null;
      } else {
        patch.statusDetail = event.length === 0 ? null : event;
      }
      break;
    }

    case 'account_review_update': {
      patch.statusDetail = `review:${value.decision ?? 'UNKNOWN'}`;
      break;
    }

    case 'phone_number_name_update': {
      // Only an approved name is adopted. A rejected request leaves the current
      // verified name in place — writing the requested one would show reps a
      // display name Meta never approved.
      if ((value.decision ?? '').toUpperCase() === 'APPROVED') {
        if (typeof value.requested_verified_name === 'string') {
          patch.displayName = value.requested_verified_name;
        }
      } else if (typeof value.rejection_reason === 'string') {
        patch.statusDetail = `name_rejected:${value.rejection_reason}`;
      }
      break;
    }

    default:
      log.debug('wa.account.unhandled_field', { field });
      break;
  }

  if (Object.keys(patch).length > 0) {
    await patchAccount(account.id, patch);
  }

  if (qualityChanged) {
    log.warn('wa.account.quality_change', {
      from: account.qualityRating,
      to: patch.qualityRating,
      /**
       * Campaign suspension on RED is the runner's job, not this function's:
       * it holds the campaign state machine and the transition audit. Recording
       * the rating here is what the runner's next tick reads.
       */
      pausesCampaigns: patch.qualityRating === QUALITY.RED,
    });
  }

  if (restricted) {
    log.error('wa.account.restricted', { detail: patch.statusDetail });
  }

  if (payload.webhookEventId !== undefined) {
    await markWebhookEvent(payload.webhookEventId, 'PROCESSED');
  }

  return { outcome: 'patched', qualityChanged, restricted };
};

/** Meta puts the reason in one of two differently-shaped blocks. */
const describeRestriction = (value: MetaChangeValue): string => {
  const ban = value.ban_info as { waba_ban_state?: string; waba_ban_date?: string } | undefined;
  const restriction = value.restriction_info as
    | { restriction_type?: string; expiration?: string }[]
    | undefined;

  if (ban?.waba_ban_state !== undefined) {
    return `ban:${ban.waba_ban_state}${ban.waba_ban_date === undefined ? '' : ` until ${ban.waba_ban_date}`}`;
  }

  if (Array.isArray(restriction) && restriction.length > 0) {
    return `restriction:${restriction.map((item) => item.restriction_type ?? 'UNKNOWN').join(',')}`;
  }

  return `event:${value.event ?? 'UNKNOWN'}`;
};

export const handler = async (
  payload: AccountEventPayload,
): Promise<AccountEventResult> => {
  try {
    return await processAccountEvent(payload);
  } catch (error) {
    if (payload.webhookEventId !== undefined) {
      await markWebhookEventFailed(
        payload.webhookEventId,
        0,
        error instanceof Error ? error.message : String(error),
      );
    }

    throw error;
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_ACCOUNT_EVENT,
  name: 'wa-account-event',
  description:
    'Applies Meta account, review, quality and display-name events to the WhatsApp account record.',
  timeoutSeconds: 15,
  handler,
});
