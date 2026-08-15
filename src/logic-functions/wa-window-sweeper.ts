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

export type SweepResult = {
  expired: number;
  autoClosed: number;
};

export const sweepWindows = async (now: Date = new Date()): Promise<SweepResult> => {
  const log = logger.child({ fn: 'wa-window-sweeper' });

  const expiring = await findExpiredOpenWindows(now, SWEEP_BATCH);

  if (expiring.length > 0) {
    await patchThreads(
      expiring.map((thread) => thread.id),
      { windowState: WINDOW_STATE.EXPIRED },
    );

    count(METRIC.WINDOW_SWEPT, expiring.length);
  }

  /**
   * Auto-close is off by default and enabling it is a config change, not new
   * code (Q-3 is still open). It is deliberately a *separate* pass from window
   * expiry: a closed conversation and an expired window mean different things,
   * and a business that wants one rarely wants the other.
   */
  const autoCloseDays = config.autoCloseDays();
  let autoClosed = 0;

  if (autoCloseDays > 0) {
    const idleSince = new Date(now.getTime() - autoCloseDays * 24 * 3_600_000);
    const idle = await findIdleThreads(idleSince, SWEEP_BATCH);

    if (idle.length > 0) {
      await patchThreads(
        idle.map((thread) => thread.id),
        { status: THREAD_STATUS.CLOSED },
      );

      autoClosed = idle.length;
      count(METRIC.THREAD_AUTO_CLOSED, autoClosed);
    }
  }

  log.info('wa.window.swept', { expired: expiring.length, autoClosed });

  return { expired: expiring.length, autoClosed };
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
