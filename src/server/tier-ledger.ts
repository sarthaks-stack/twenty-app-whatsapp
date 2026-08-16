import { kv } from 'twenty-sdk/logic-function';

import {
  TIER_LIMITS,
  isTierWindowExpired,
  tierBudget,
  type TierBudget,
} from '../domain/campaign/tier-budget';
import { MESSAGING_TIER, type MessagingTier } from '../domain/constants';
import { config } from './config';
import { describeError, logger } from './logger';
import { patchAccount, type WhatsappAccountRecord } from './repositories/accounts';
import { toDate } from './repositories/base';

/**
 * The messaging-tier ledger (AR-21, specs/07 §7).
 *
 * Meta's limit counts **unique users messaged business-initiated in a rolling
 * 24 hours**, across every source. So the ledger is a set of `waId`s in `kv`
 * and a counter on the account record — the set answers "have we already
 * counted this person today?", the counter is the queryable projection the
 * runner and the pre-flight panel read.
 *
 * **It is an estimate, and it says so.** `kv` has no compare-and-swap, so a
 * concurrent send can lose an addition to the set (counting someone twice, so
 * the estimate runs high) or lose an increment to the counter (running low).
 * Meta's own `messaging_limit_tier` is the truth, reconciled hourly by
 * `wa-health-check`. The reserve exists so that being wrong by a few is
 * harmless; being wrong by a few hundred would show up in the reconciliation
 * long before it mattered.
 */

/**
 * How many distinct numbers one window tracks.
 *
 * Above this the set stops growing and every business-initiated send counts as
 * new. That **over**-counts, which is the safe direction: a campaign pauses
 * into `tier_waiting` sooner than it strictly had to, rather than sending past
 * a limit Meta enforces by blocking the number. A workspace that hits this is
 * on a tier where Meta's own reconciliation is the practical control anyway.
 */
export const MAX_TRACKED_UNIQUE_USERS = 20_000;

/**
 * Keyed by the window anchor, not by the clock.
 *
 * When `wa-health-check` rolls `tierWindowStartedAt`, every key from the old
 * window becomes unreachable and the new window starts empty — no deletion
 * pass, and no chance of a stale entry suppressing a count that should have
 * happened.
 */
export const tierSetKey = (
  accountId: string,
  windowStartedAt: Date | null,
): string =>
  `wa:tier:${accountId}:${windowStartedAt === null ? 'unanchored' : windowStartedAt.toISOString().slice(0, 13)}`;

type TierSet = { waIds: string[]; truncated?: boolean };

export const tierFor = (account: WhatsappAccountRecord): MessagingTier =>
  (account.messagingLimitTier ?? MESSAGING_TIER.TIER_250) in TIER_LIMITS
    ? (account.messagingLimitTier as MessagingTier)
    : MESSAGING_TIER.TIER_250;

/** What a campaign may consume right now, after the interactive reserve. */
export const budgetForAccount = (account: WhatsappAccountRecord): TierBudget =>
  tierBudget({
    tier: tierFor(account),
    used: account.tierUniqueUsersUsed ?? 0,
    reservePct: config.campaignTierReservePct(),
  });

/**
 * Whether the window this account's counter belongs to has aged out.
 *
 * Read by the runner so a `tier_waiting` campaign resumes the moment the
 * window rolls rather than waiting for the hourly health check to notice —
 * FR-CAM-7's "auto-resuming next cycle" measured in minutes, not in an hour.
 */
export const isWindowExpired = (
  account: WhatsappAccountRecord,
  now: Date,
): boolean => isTierWindowExpired(toDate(account.tierWindowStartedAt), now);

export type LedgerResult = { counted: boolean; used: number };

/**
 * Records one business-initiated send against the window.
 *
 * Returns `counted: false` when this number was already in the window — the
 * common case for a campaign that reaches the same contact twice across two
 * campaigns, and the whole reason a plain increment would be wrong.
 *
 * Every failure is swallowed. A ledger write must never fail a send that Meta
 * has already accepted: the message is out, and losing the count costs an
 * estimate that reconciles hourly, while throwing here would fail a message
 * the customer has already received.
 */
export const recordBusinessInitiated = async ({
  account,
  waId,
  now = new Date(),
}: {
  account: WhatsappAccountRecord;
  waId: string;
  now?: Date;
}): Promise<LedgerResult> => {
  const used = account.tierUniqueUsersUsed ?? 0;

  try {
    /**
     * An expired window is rolled here rather than deferred to the health
     * check. The alternative counts a fresh day's sends against yesterday's
     * exhausted allowance for up to an hour, which reads to an operator as a
     * campaign that will not start for no reason.
     */
    const previousAnchor = toDate(account.tierWindowStartedAt);
    const expired = isTierWindowExpired(previousAnchor, now);

    // `isTierWindowExpired` answers true for a missing anchor, so the
    // non-expired branch always has one.
    const windowStartedAt = expired ? now : previousAnchor!;
    const baseline = expired ? 0 : used;

    const key = tierSetKey(account.id, windowStartedAt);
    const stored = (await kv.get<TierSet>(key, { scope: 'WORKSPACE' })) ?? { waIds: [] };

    if (stored.waIds.includes(waId)) {
      return { counted: false, used: baseline };
    }

    const next: TierSet =
      stored.waIds.length >= MAX_TRACKED_UNIQUE_USERS
        ? { ...stored, truncated: true }
        : { waIds: [...stored.waIds, waId] };

    await kv.set(key, next, { scope: 'WORKSPACE' });

    const total = baseline + 1;

    await patchAccount(account.id, {
      tierUniqueUsersUsed: total,
      ...(expired ? { tierWindowStartedAt: windowStartedAt.toISOString() } : {}),
    });

    if (expired && previousAnchor !== null) {
      logger.info('wa.tier.window_rolled', { accountId: account.id });
    }

    return { counted: true, used: total };
  } catch (error) {
    logger.warn('wa.tier.ledger_write_failed', {
      accountId: account.id,
      ...describeError(error),
    });

    return { counted: false, used };
  }
};
