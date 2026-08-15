import { enqueueJob } from 'twenty-sdk/logic-function';

import { describeError, logger } from './logger';

/**
 * Job enqueueing.
 *
 * Wrapped for two reasons. The retry limit is a policy decision, not a per-call
 * detail — a processor that silently defaulted to no retries would drop work on
 * the first transient error. And a failure to enqueue must be *loud*: it is the
 * one failure mode that leaves a raw webhook row marked received with nothing
 * scheduled to process it, which looks exactly like success until someone
 * notices the messages never appeared.
 */

export const DEFAULT_RETRY_LIMIT = 3;

export type EnqueueInput = {
  logicFunctionUniversalIdentifier: string;
  payload?: Record<string, unknown>;
  retryLimit?: number;
  delayMs?: number;
  /** For the log line; the WAMID or dedup key this job is about. */
  correlationId?: string | null;
};

export const enqueue = async ({
  logicFunctionUniversalIdentifier,
  payload,
  retryLimit = DEFAULT_RETRY_LIMIT,
  delayMs,
  correlationId = null,
}: EnqueueInput): Promise<boolean> => {
  try {
    const result = await enqueueJob({
      logicFunctionUniversalIdentifier,
      ...(payload === undefined ? {} : { payload }),
      retryLimit,
      ...(delayMs === undefined ? {} : { delayMs }),
    });

    if (result.enqueued !== true) {
      logger.error('job.enqueue_refused', {
        correlationId,
        target: logicFunctionUniversalIdentifier,
      });
    }

    return result.enqueued === true;
  } catch (error) {
    logger.error('job.enqueue_failed', {
      correlationId,
      target: logicFunctionUniversalIdentifier,
      ...describeError(error),
    });

    return false;
  }
};

/**
 * Enqueues many jobs, reporting how many landed.
 *
 * Sequential rather than `Promise.all`: a fan-out of 50 statuses issued at once
 * competes with the very processors it is scheduling, and the ingest function
 * has a 30-second budget it is nowhere near using.
 */
export const enqueueAll = async (inputs: EnqueueInput[]): Promise<number> => {
  let enqueued = 0;

  for (const input of inputs) {
    if (await enqueue(input)) enqueued += 1;
  }

  return enqueued;
};
