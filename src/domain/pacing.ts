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

/**
 * The campaign lane is never squeezed to nothing, however small the ceiling —
 * a rate of zero is not slow, it is stopped, and it would divide by zero on the
 * way there.
 */
const CAMPAIGN_FLOOR_PER_SECOND = 1;

/**
 * How fast one lane may send, given the account's ceiling.
 *
 * **The two lanes always sum to exactly `throttlePerSecond`.** They used to be
 * computed independently, each with its own floor, so a small ceiling produced
 * lanes that added up to more than the account allowed: at `throttlePerSecond:
 * 3` the interactive floor alone returned 5, the campaign floor 1.8, and the
 * pacing designed to keep us under Meta's limit handed out 6.8/s (D-29).
 *
 * Interactive is served first — someone is waiting for it (AR-19) — but only up
 * to what is left after the campaign lane's floor, so priority never becomes
 * starvation in either direction.
 */
export const laneRate = (lane: Lane, rates: LaneRates = DEFAULT_LANE_RATES): number => {
  const ceiling = Math.max(0, rates.throttlePerSecond);

  if (ceiling === 0) return 0;

  const minimum = rates.minimumInteractivePerSecond ?? 5;
  const campaignFloor = Math.min(CAMPAIGN_FLOOR_PER_SECOND, ceiling / 2);

  const interactive = Math.min(
    Math.max(minimum, ceiling * rates.interactiveShare),
    ceiling - campaignFloor,
  );

  return lane === LANE.INTERACTIVE ? interactive : ceiling - interactive;
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
