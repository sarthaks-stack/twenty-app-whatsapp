import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LANE } from '../domain/constants';

/**
 * NFR-S5 under load (specs/12 §5) — the test that proves D-5.
 *
 * The requirement is that a rep's send stays under three seconds *while* a
 * campaign runs at full campaign-lane rate. A single shared pacing cursor would
 * put that send behind everything the campaign had already queued: at 10 000
 * recipients and 12/s, fourteen minutes — not three seconds, and not a number
 * any amount of tuning would fix.
 *
 * Two cursors make the guarantee structural instead of best-effort. The
 * interactive slot is computed from a number the campaign never writes, so the
 * campaign's depth cannot appear in it at all — which is why this can be
 * asserted here, at the real 10 000, rather than measured on a staging box and
 * hoped for.
 *
 * It lives in its own file because it mocks the account repository and the job
 * queue, and `load.test.ts` deliberately mocks nothing.
 */

const patchAccount = vi.fn();
const enqueue = vi.fn();

vi.mock('../server/repositories/accounts', () => ({
  patchAccount: (...args: unknown[]) => patchAccount(...args),
}));

vi.mock('../server/jobs', () => ({ enqueue: (...args: unknown[]) => enqueue(...args) }));

const { scheduleSend } = await import('../server/schedule');

const NOW = new Date('2026-08-17T09:00:00.000Z').getTime();

const account = (overrides: Record<string, unknown> = {}) =>
  ({ id: 'acc1', sendThrottlePerSecond: 20, ...overrides }) as never;

beforeEach(() => {
  patchAccount.mockReset();
  enqueue.mockReset();
  enqueue.mockResolvedValue(true);
});

describe('a rep sending while a campaign runs', () => {
  it('places the interactive send immediately, whatever the campaign has queued', async () => {
    const campaign = await scheduleSend({
      messageIds: Array.from({ length: 10_000 }, (_unused, index) => `c${index}`),
      lane: LANE.CAMPAIGN,
      account: account(),
      now: NOW,
    });

    /** The campaign lane really is saturated — over ten minutes of sending queued. */
    expect(campaign.nextCursorAt - NOW).toBeGreaterThan(10 * 60_000);

    const interactive = await scheduleSend({
      messageIds: ['i1'],
      lane: LANE.INTERACTIVE,
      /** The account as the campaign left it: its campaign cursor is far ahead. */
      account: account({ campaignCursorAt: new Date(campaign.nextCursorAt).toISOString() }),
      now: NOW,
    });

    expect(interactive.slots[0]! - NOW).toBeLessThanOrEqual(3_000);
    expect(interactive.enqueued).toBe(1);
  });

  /**
   * The converse, and the reason the split is a *split* rather than a priority
   * queue: a busy day of 1:1 traffic must not silently stall a campaign either.
   */
  it('does not let a busy interactive lane push the campaign back', async () => {
    const interactive = await scheduleSend({
      messageIds: Array.from({ length: 2_000 }, (_unused, index) => `i${index}`),
      lane: LANE.INTERACTIVE,
      account: account(),
      now: NOW,
    });

    const campaign = await scheduleSend({
      messageIds: ['c1'],
      lane: LANE.CAMPAIGN,
      account: account({
        interactiveCursorAt: new Date(interactive.nextCursorAt).toISOString(),
      }),
      now: NOW,
    });

    expect(campaign.slots[0]! - NOW).toBeLessThanOrEqual(3_000);
  });

  /**
   * Each lane still paces *itself*. The cursor is written before any job is
   * enqueued — the other order would leave the cursor in the past after a crash
   * mid-batch, and the next batch would burst on top of messages already in
   * flight, precisely when the system has just proved it is unwell.
   */
  it('advances its own cursor before enqueueing anything', async () => {
    await scheduleSend({
      messageIds: ['c1', 'c2', 'c3'],
      lane: LANE.CAMPAIGN,
      account: account(),
      now: NOW,
    });

    expect(patchAccount).toHaveBeenCalledTimes(1);
    expect(patchAccount.mock.invocationCallOrder[0]!).toBeLessThan(
      enqueue.mock.invocationCallOrder[0]!,
    );
    expect(patchAccount.mock.calls[0]![1]).toHaveProperty('campaignCursorAt');
  });

  /**
   * `retryLimit: 0`, on every send job, at any volume. A platform retry re-runs
   * the whole send with no knowledge of whether Meta already accepted the first
   * attempt — the one way to double-message a customer at scale.
   */
  it('never hands a send job to the platform’s retry', async () => {
    await scheduleSend({
      messageIds: Array.from({ length: 500 }, (_unused, index) => `c${index}`),
      lane: LANE.CAMPAIGN,
      account: account(),
      now: NOW,
    });

    const limits = enqueue.mock.calls.map((call) => (call[0] as { retryLimit: number }).retryLimit);

    expect(limits).toHaveLength(500);
    expect(new Set(limits)).toEqual(new Set([0]));
  });
});
