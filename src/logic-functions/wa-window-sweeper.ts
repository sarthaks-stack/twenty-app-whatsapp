import { defineLogicFunction } from 'twenty-sdk/define';

import { LF_WINDOW_SWEEPER } from '../constants/universal-identifiers';
import { THREAD_STATUS, WINDOW_STATE } from '../domain/constants';
import { config } from '../server/config';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import {
  findExpiredOpenWindows,
  findIdleThreads,
  patchThreads,
} from '../server/repositories/threads';

/**
 * The 15-minute window cache refresh (FR-THR-5, specs/05 §3.4).
 *
 * `windowState` is a denormalised column that exists so inbox filters and the
 * composer can react without new events. **The server never trusts it for a
 * send decision** — the sender recomputes from `serviceWindowExpiresAt` every
 * time (specs/04 §1.1), which is precisely what makes this function a UX
 * nicety rather than a correctness dependency. If it never ran, filters would
 * lag and nothing would be sent that should not have been.
 *
 * Cost is bounded by the query, not by the table: at 100 000 threads only the
 * ones that expired in the last quarter hour match.
 */

export const SWEEP_BATCH = 60;

/**
 * How many batches one run will take.
 *
 * A single batch per run was a **quiet cap**: at more than 60 windows expiring
 * per quarter hour the backlog grew for ever, and because each run reported
 * "swept 60" it looked healthy the whole way (D-33). Twenty passes is 1 200
 * threads a run — 4 800 an hour — inside the 60-second budget, and a run that
 * reaches the cap says so, which is what makes the next one a decision rather
 * than a discovery.
 */
export const MAX_SWEEP_PASSES = 20;

export type SweepResult = {
  expired: number;
  autoClosed: number;
  /** True when a pass limit stopped the sweep with work still outstanding. */
  truncated: boolean;
};

/**
 * Drains one kind of stale thread.
 *
 * Each pass re-runs the query rather than paging a cursor: the patch takes the
 * rows it touched *out* of the result set, so the next page is whatever is
 * still stale — which is also what makes it safe against threads changing
 * underneath the sweep.
 */
const drain = async (
  read: (limit: number) => Promise<{ id: string }[]>,
  patch: Parameters<typeof patchThreads>[1],
): Promise<{ swept: number; truncated: boolean }> => {
  let swept = 0;

  for (let pass = 0; pass < MAX_SWEEP_PASSES; pass += 1) {
    const batch = await read(SWEEP_BATCH);

    if (batch.length === 0) return { swept, truncated: false };

    await patchThreads(
      batch.map((thread) => thread.id),
      patch,
    );

    swept += batch.length;

    if (batch.length < SWEEP_BATCH) return { swept, truncated: false };
  }

  return { swept, truncated: true };
};

export const sweepWindows = async (now: Date = new Date()): Promise<SweepResult> => {
  const log = logger.child({ fn: 'wa-window-sweeper' });

  const expiring = await drain(
    (limit) => findExpiredOpenWindows(now, limit),
    { windowState: WINDOW_STATE.EXPIRED },
  );

  if (expiring.swept > 0) count(METRIC.WINDOW_SWEPT, expiring.swept);

  /**
   * Auto-close is off by default and enabling it is a config change, not new
   * code (Q-3 is still open). It is deliberately a *separate* pass from window
   * expiry: a closed conversation and an expired window mean different things,
   * and a business that wants one rarely wants the other.
   */
  const autoCloseDays = config.autoCloseDays();
  let closing = { swept: 0, truncated: false };

  if (autoCloseDays > 0) {
    const idleSince = new Date(now.getTime() - autoCloseDays * 24 * 3_600_000);

    closing = await drain((limit) => findIdleThreads(idleSince, limit), {
      status: THREAD_STATUS.CLOSED,
    });

    if (closing.swept > 0) count(METRIC.THREAD_AUTO_CLOSED, closing.swept);
  }

  const truncated = expiring.truncated || closing.truncated;

  const result: SweepResult = {
    expired: expiring.swept,
    autoClosed: closing.swept,
    truncated,
  };

  if (truncated) {
    count(METRIC.WINDOW_SWEEP_TRUNCATED);
    log.warn('wa.window.sweep_truncated', result);
  }

  log.info('wa.window.swept', result);

  return result;
};

export const handler = async (): Promise<SweepResult> => {
  try {
    return await sweepWindows();
  } catch (error) {
    logger.error('wa.window.sweep_failed', describeError(error));

    throw error;
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_WINDOW_SWEEPER,
  name: 'wa-window-sweeper',
  description:
    'Refreshes the denormalised service-window state so inbox filters stay accurate.',
  timeoutSeconds: 60,
  cronTriggerSettings: { pattern: '*/15 * * * *' },
  handler,
});
