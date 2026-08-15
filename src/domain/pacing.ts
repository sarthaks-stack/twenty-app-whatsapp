import { LANE, type Lane } from './constants';

/**
 * Deterministic send pacing (specs/00 D-5, AR-12, AR-19).
 *
 * `kv` has no compare-and-swap, so a token bucket read-modify-written by
 * concurrent senders loses updates and either over-sends (Meta 130429) or
 * stalls. Instead the *enqueuing* function — a single writer per batch — assigns
 * each message an absolute slot and advances a cursor stored on the account.
 *
 * Two independent cursors implement the AR-19 priority split structurally
 * rather than by best effort: a campaign saturating its lane cannot push an
 * interactive send into the future, because they never touch the same cursor.
 */

export type LaneRates = {
  /** The account's own ceiling, kept well below Meta's 80/s. */
  throttlePerSecond: number;
  /** Share of that ceiling reserved for interactive traffic. */
  interactiveShare: number;
  /** Interactive never paces slower than this, however small the share. */
  minimumInteractivePerSecond?: number;
};

export const DEFAULT_LANE_RATES: LaneRates = {
  throttlePerSecond: 20,
  interactiveShare: 0.4,
  minimumInteractivePerSecond: 5,
};

export const laneRate = (lane: Lane, rates: LaneRates = DEFAULT_LANE_RATES): number => {
  const { throttlePerSecond, interactiveShare } = rates;
  const minimum = rates.minimumInteractivePerSecond ?? 5;

  if (lane === LANE.INTERACTIVE) {
    return Math.max(minimum, throttlePerSecond * interactiveShare);
  }

  return Math.max(1, throttlePerSecond * (1 - interactiveShare));
};

export type SlotPlan = {
  /** Absolute epoch-ms send times, one per message, in order. */
  slots: number[];
  /** Written back to the account before any job is enqueued. */
  nextCursorAt: number;
};

/**
 * Slots start at `max(now, cursor)`: a cursor left in the past by a quiet
 * period must not licence a burst, and a cursor in the future must not be
 * jumped.
 */
export const computeSlots = ({
  cursorAt,
  now,
  count,
  ratePerSecond,
}: {
  cursorAt: number | null | undefined;
  now: number;
  count: number;
  ratePerSecond: number;
}): SlotPlan => {
  if (count <= 0) return { slots: [], nextCursorAt: Math.max(now, cursorAt ?? 0) };
  if (ratePerSecond <= 0) throw new Error('ratePerSecond must be greater than zero');

  const spacingMs = 1000 / ratePerSecond;
  const start = Math.max(now, cursorAt ?? 0);
  const slots = Array.from({ length: count }, (_, i) => Math.round(start + i * spacingMs));

  return { slots, nextCursorAt: Math.round(start + count * spacingMs) };
};

/** What `enqueueJob` needs: never negative, since a past slot means "send now". */
export const delayForSlot = (slot: number, now: number): number => Math.max(0, slot - now);

/**
 * Per-recipient spacing against Meta's undocumented pair rate limit (131056).
 * Returns the milliseconds a send must wait, or 0 when it may proceed.
 */
export const recipientSpacingDelayMs = ({
  lastOutboundAt,
  now,
  minimumSpacingMs,
}: {
  lastOutboundAt: Date | null | undefined;
  now: number;
  minimumSpacingMs: number;
}): number => {
  if (!(lastOutboundAt instanceof Date)) return 0;

  const elapsed = now - lastOutboundAt.getTime();
  if (elapsed >= minimumSpacingMs) return 0;

  return minimumSpacingMs - elapsed;
};

/** Exponential backoff with full jitter (AR-13). */
export const backoffDelayMs = (
  attempt: number,
  random: () => number,
  baseMs = 2000,
  maxAttempts = 5,
): number | null => {
  if (attempt >= maxAttempts) return null;

  return Math.round(random() * baseMs * 2 ** attempt);
};
