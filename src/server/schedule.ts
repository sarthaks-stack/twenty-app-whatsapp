import { LF_OUTBOUND_SENDER } from '../constants/universal-identifiers';
import { LANE, type Lane } from '../domain/constants';
import { computeSlots, delayForSlot, laneRate, type LaneRates } from '../domain/pacing';
import { config, forAccount } from './config';
import { enqueue } from './jobs';
import { logger } from './logger';
import { METRIC, count } from './metrics';
import { patchAccount, type WhatsappAccountRecord } from './repositories/accounts';
import { toDate } from './repositories/base';

/**
 * The only place that knows about send rate limits (specs/04 §4, D-5, AR-12,
 * AR-19).
 *
 * `kv` has no compare-and-swap, so a token bucket shared by concurrent senders
 * would lose updates and either over-send (Meta 130429) or stall. Instead the
 * *enqueuing* side — one writer per batch — assigns every message an absolute
 * slot and advances a cursor stored on the account. Nothing at send time has to
 * coordinate with anything.
 *
 * **Two cursors, not one.** Interactive and campaign traffic advance separate
 * cursors, which is what makes NFR-S5 structural rather than best-effort: a
 * campaign saturating its lane cannot push a rep's reply into the future,
 * because the two never touch the same number.
 */

export const laneRatesFor = (account: WhatsappAccountRecord): LaneRates => ({
  throttlePerSecond: forAccount(account.sendThrottlePerSecond, config.sendThrottlePerSecond),
  interactiveShare: config.interactiveLaneShare(),
});

export const CURSOR_FIELD = {
  [LANE.INTERACTIVE]: 'interactiveCursorAt',
  [LANE.CAMPAIGN]: 'campaignCursorAt',
} as const satisfies Record<Lane, 'interactiveCursorAt' | 'campaignCursorAt'>;

export const cursorValue = (account: WhatsappAccountRecord, lane: Lane): number | null => {
  const raw = lane === LANE.INTERACTIVE ? account.interactiveCursorAt : account.campaignCursorAt;
  const parsed = toDate(raw);

  return parsed === null ? null : parsed.getTime();
};

export type ScheduleResult = {
  /** Absolute epoch-ms send times, aligned with the ids passed in. */
  slots: number[];
  nextCursorAt: number;
  enqueued: number;
  ratePerSecond: number;
};

/**
 * Assigns slots, advances the cursor, and enqueues one sender job per message.
 *
 * The cursor is written **before** any job is enqueued. The other order looks
 * more natural and is wrong: a crash between the last enqueue and the cursor
 * write would leave the cursor in the past, and the next batch would be paced
 * on top of messages already in flight — a burst precisely when the system has
 * just proved it is unwell.
 *
 * `retryLimit: 0` is equally deliberate. A platform retry re-runs the whole
 * send with no knowledge of whether Meta already accepted the first attempt,
 * which is the one way to double-message a customer. Retry belongs to the
 * sender, keyed on the message's own state.
 */
export const scheduleSend = async ({
  messageIds,
  lane,
  account,
  now = Date.now(),
}: {
  messageIds: string[];
  lane: Lane;
  account: WhatsappAccountRecord;
  now?: number;
}): Promise<ScheduleResult> => {
  const ratePerSecond = laneRate(lane, laneRatesFor(account));

  const { slots, nextCursorAt } = computeSlots({
    cursorAt: cursorValue(account, lane),
    now,
    count: messageIds.length,
    ratePerSecond,
  });

  if (messageIds.length === 0) {
    return { slots, nextCursorAt, enqueued: 0, ratePerSecond };
  }

  const cursorAt = new Date(nextCursorAt).toISOString();

  await patchAccount(
    account.id,
    lane === LANE.INTERACTIVE
      ? { interactiveCursorAt: cursorAt }
      : { campaignCursorAt: cursorAt },
  );

  let enqueued = 0;

  for (const [index, messageId] of messageIds.entries()) {
    const landed = await enqueue({
      logicFunctionUniversalIdentifier: LF_OUTBOUND_SENDER,
      payload: { messageId },
      delayMs: delayForSlot(slots[index]!, now),
      retryLimit: 0,
      correlationId: messageId,
    });

    if (landed) enqueued += 1;
  }

  count(METRIC.SEND_SCHEDULED, enqueued);

  logger.debug('wa.send.scheduled', {
    accountId: account.id,
    lane,
    ratePerSecond,
    count: messageIds.length,
    enqueued,
  });

  return { slots, nextCursorAt, enqueued, ratePerSecond };
};

/**
 * A sender re-enqueuing itself — retry backoff, or per-recipient spacing.
 *
 * Deliberately *not* routed through `scheduleSend`: the message already
 * consumed a slot, and advancing the cursor again would make every retry
 * shrink the lane's effective capacity.
 */
export const rescheduleSend = async ({
  messageId,
  delayMs,
  attempt,
}: {
  messageId: string;
  delayMs: number;
  attempt?: number;
}): Promise<boolean> =>
  enqueue({
    logicFunctionUniversalIdentifier: LF_OUTBOUND_SENDER,
    payload: { messageId, ...(attempt === undefined ? {} : { attempt }) },
    delayMs,
    retryLimit: 0,
    correlationId: messageId,
  });
