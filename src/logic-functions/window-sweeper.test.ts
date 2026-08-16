import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 15-minute window sweep (D-33).
 *
 * The defect: one batch of 60 per run, with no indication that more was
 * waiting. Above 60 expiries a quarter hour the backlog grew for ever while
 * every run reported a healthy "swept 60" — a cap that reads as a result.
 */

const findExpiredOpenWindows = vi.fn();
const findIdleThreads = vi.fn();
const patchThreads = vi.fn();

vi.mock('../server/repositories/threads', () => ({
  findExpiredOpenWindows: (...args: unknown[]) => findExpiredOpenWindows(...args),
  findIdleThreads: (...args: unknown[]) => findIdleThreads(...args),
  patchThreads: (...args: unknown[]) => patchThreads(...args),
}));

vi.mock('twenty-sdk/define', () => ({ defineLogicFunction: (d: unknown) => d }));

const { MAX_SWEEP_PASSES, SWEEP_BATCH, sweepWindows } = await import('./wa-window-sweeper');

const ORIGINAL_ENV = { ...process.env };

/** A queue of `total` stale threads, handed out `limit` at a time. */
const queueOf = (total: number) => {
  let remaining = total;

  return async (_at: Date, limit: number) => {
    const size = Math.min(limit, remaining);

    remaining -= size;

    return Array.from({ length: size }, (_unused, index) => ({ id: `t-${remaining + index}` }));
  };
};

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, WA_AUTO_CLOSE_DAYS: '0' };
  findExpiredOpenWindows.mockReset();
  findIdleThreads.mockReset();
  patchThreads.mockReset();
  patchThreads.mockResolvedValue(undefined);
  findIdleThreads.mockResolvedValue([]);
});

describe('sweeping expired windows', () => {
  it('does nothing when nothing has expired', async () => {
    findExpiredOpenWindows.mockResolvedValue([]);

    expect(await sweepWindows()).toEqual({ expired: 0, autoClosed: 0, truncated: false });
    expect(patchThreads).not.toHaveBeenCalled();
  });

  it('sweeps a partial batch in one pass', async () => {
    findExpiredOpenWindows.mockImplementation(queueOf(17));

    expect(await sweepWindows()).toMatchObject({ expired: 17, truncated: false });
    expect(findExpiredOpenWindows).toHaveBeenCalledTimes(1);
  });

  /** The defect, directly: more than one batch of work in a single run. */
  it('keeps going past the first batch', async () => {
    findExpiredOpenWindows.mockImplementation(queueOf(SWEEP_BATCH * 3 + 5));

    expect(await sweepWindows()).toMatchObject({
      expired: SWEEP_BATCH * 3 + 5,
      truncated: false,
    });
  });

  it('stops at the pass limit and says so', async () => {
    findExpiredOpenWindows.mockImplementation(queueOf(SWEEP_BATCH * (MAX_SWEEP_PASSES + 4)));

    const result = await sweepWindows();

    expect(result).toMatchObject({
      expired: SWEEP_BATCH * MAX_SWEEP_PASSES,
      truncated: true,
    });
  });

  /** An exactly-full last batch must not cost an extra query to discover. */
  it('makes one final query when the work divides evenly', async () => {
    findExpiredOpenWindows.mockImplementation(queueOf(SWEEP_BATCH * 2));

    await sweepWindows();

    expect(findExpiredOpenWindows).toHaveBeenCalledTimes(3);
  });
});

describe('auto-closing idle conversations', () => {
  it('stays off unless it is configured on', async () => {
    findExpiredOpenWindows.mockResolvedValue([]);

    expect((await sweepWindows()).autoClosed).toBe(0);
    expect(findIdleThreads).not.toHaveBeenCalled();
  });

  it('drains idle threads past the first batch too', async () => {
    process.env.WA_AUTO_CLOSE_DAYS = '30';
    findExpiredOpenWindows.mockResolvedValue([]);
    findIdleThreads.mockImplementation(queueOf(SWEEP_BATCH + 3));

    expect(await sweepWindows()).toMatchObject({ autoClosed: SWEEP_BATCH + 3 });
  });

  /** Two different meanings, so two different writes — never one combined patch. */
  it('closes threads separately from expiring windows', async () => {
    process.env.WA_AUTO_CLOSE_DAYS = '30';
    findExpiredOpenWindows.mockImplementation(queueOf(2));
    findIdleThreads.mockImplementation(queueOf(2));

    await sweepWindows();

    expect(patchThreads.mock.calls.map((call) => call[1])).toEqual([
      { windowState: 'EXPIRED' },
      { status: 'CLOSED' },
    ]);
  });
});
