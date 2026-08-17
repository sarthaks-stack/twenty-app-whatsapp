import { defineLogicFunction } from 'twenty-sdk/define';
import { kv } from 'twenty-sdk/logic-function';

import { LF_RETENTION_PURGE } from '../constants/universal-identifiers';
import { config } from '../server/config';
import { describeError, logger } from '../server/logger';
import { METRIC, count, purgeMetricsForDay } from '../server/metrics';
import {
  blankMessageContent,
  findPurgeableMessages,
} from '../server/repositories/messages';
import {
  destroyWebhookEvents,
  findExpiredWebhookEvents,
} from '../server/repositories/webhook-events';

/**
 * Retention (SEC-9, specs/10 §4.2).
 *
 * Three windows, and they are deliberately different in kind.
 *
 * **The raw webhook log is deleted.** It is the only source for reprocessing —
 * Meta retries for seven days and has no replay API — so its retention has a
 * hard floor of seven days, enforced in `config`, and past the window the rows
 * are *destroyed* rather than soft-deleted: `dedupKey` carries a unique index, a
 * soft-deleted row keeps its indexed value, and a redelivery colliding with a
 * tombstone would be discarded as a duplicate with nothing left to replay from.
 *
 * **Messages are emptied, not deleted.** `body`, `payload`, `mediaMeta` and the
 * stored file go; `wamid`, `direction`, `status`, `statusTimestamps`,
 * `billableCostUsd` and the template columns stay. Deleting the rows would make
 * every historical delivery report and every cost figure wrong, which is not
 * what a retention policy is for. The timeline stays readable because activity
 * properties carry their own 120-character excerpt (specs/09 §4.1).
 *
 * **Counters expire on a fixed 90 days**, which is not configurable because
 * nobody trends an approximate counter over a year.
 *
 * The job logs counts. It never logs content — which is the one way a retention
 * job can defeat its own purpose.
 */

/** Rows touched per Core API call. Matches the 60-record chunking (NFR-R2). */
export const PURGE_BATCH = 60;

/**
 * Passes per kind, per run.
 *
 * A daily cron with an unbounded loop is a daily cron that eventually runs for
 * an hour. Twelve passes is 720 rows of each kind per run; a backlog larger than
 * that drains over several days *and says so*, because a run that reaches the
 * cap reports `truncated` — the failure the window sweeper had, where every run
 * reported its cap as a success and the backlog grew for ever (D-33).
 */
export const MAX_PURGE_PASSES = 12;

/**
 * How many days of counters one run will clear.
 *
 * The marker below makes the purge resumable, so a cron that missed a week
 * catches up over a week rather than issuing several hundred `kv` deletes in one
 * invocation.
 */
export const MAX_METRIC_DAYS_PER_RUN = 7;

/** Fixed by SEC-9; deliberately not an application variable. */
export const METRIC_RETENTION_DAYS = 90;

export const METRIC_PURGE_MARKER = 'wa:retention:metrics-purged-through';

const DAY_MS = 24 * 3_600_000;

export type PurgeResult = {
  webhookEvents: number;
  messages: number;
  metricDays: number;
  metricKeys: number;
  /** True when a pass limit stopped a purge with rows still outstanding. */
  truncated: boolean;
};

const dayKey = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * Drains one kind of expired row.
 *
 * Each pass re-runs the query rather than paging a cursor: the write takes the
 * rows it touched *out* of the result set, so the next page is whatever is still
 * expired. That is also what makes it safe against rows arriving underneath the
 * purge — and, for messages, why the "still holds content" predicate in the
 * query is load-bearing rather than an optimisation.
 */
const drain = async (
  read: (limit: number) => Promise<{ id: string }[]>,
  write: (ids: string[]) => Promise<void>,
): Promise<{ purged: number; truncated: boolean }> => {
  let purged = 0;

  for (let pass = 0; pass < MAX_PURGE_PASSES; pass += 1) {
    const batch = await read(PURGE_BATCH);

    if (batch.length === 0) return { purged, truncated: false };

    await write(batch.map((row) => row.id));

    purged += batch.length;

    if (batch.length < PURGE_BATCH) return { purged, truncated: false };
  }

  return { purged, truncated: true };
};

/**
 * Clears counters day by day, remembering where it got to.
 *
 * `kv` cannot be scanned, so the keys are reconstructed from the metric catalog
 * and the date. A fixed "delete the day that just fell out of the window" would
 * leak an entire day of keys every time the cron missed a run; the marker makes
 * the purge resumable instead, and the per-run cap keeps a long catch-up from
 * turning into one enormous invocation.
 */
export const purgeMetrics = async (
  now: Date,
): Promise<{ days: number; keys: number }> => {
  const cutoff = new Date(now.getTime() - METRIC_RETENTION_DAYS * DAY_MS);

  const marker = await kv.get<string>(METRIC_PURGE_MARKER, { scope: 'WORKSPACE' });

  /**
   * A first run has no marker and cannot start from the epoch, but it also
   * cannot start *at* the cutoff: a workspace that ran the app before this job
   * existed already holds expired counters, and `kv` has no scan to find them,
   * so anything the first run steps over is unreachable for ever.
   *
   * So it begins one full retention window behind the cutoff and walks forward
   * at the per-run cap — a fortnight of catch-up, unattended, after which the
   * marker keeps it at one day per run.
   */
  const from =
    typeof marker === 'string' && marker.length === 10
      ? new Date(`${marker}T00:00:00.000Z`).getTime() + DAY_MS
      : cutoff.getTime() - METRIC_RETENTION_DAYS * DAY_MS;

  let days = 0;
  let keys = 0;
  let cursor = from;
  let purgedThrough: string | null = null;

  while (cursor <= cutoff.getTime() && days < MAX_METRIC_DAYS_PER_RUN) {
    const day = new Date(cursor);

    keys += await purgeMetricsForDay(day);
    purgedThrough = dayKey(day);
    days += 1;
    cursor += DAY_MS;
  }

  if (purgedThrough !== null) {
    await kv.set(METRIC_PURGE_MARKER, purgedThrough, { scope: 'WORKSPACE' });
  }

  return { days, keys };
};

export const purge = async (now: Date = new Date()): Promise<PurgeResult> => {
  const log = logger.child({ fn: 'wa-retention-purge' });

  const eventCutoff = new Date(now.getTime() - config.retentionWebhookEventDays() * DAY_MS);

  const events = await drain(
    (limit) => findExpiredWebhookEvents(eventCutoff, limit),
    destroyWebhookEvents,
  );

  if (events.purged > 0) count(METRIC.RETENTION_EVENTS_PURGED, events.purged);

  /**
   * Zero months means keep everything, and it is the default until counsel
   * answers Q-4 (Lei 22/11, GDPR where applicable). The default is deliberately
   * the reversible one: content kept can still be purged later, content purged
   * cannot be brought back.
   */
  const months = config.retentionMessageMonths();
  let messages = { purged: 0, truncated: false };

  if (months > 0) {
    const messageCutoff = new Date(now.getTime());

    messageCutoff.setUTCMonth(messageCutoff.getUTCMonth() - months);

    messages = await drain(
      (limit) => findPurgeableMessages(messageCutoff, limit),
      blankMessageContent,
    );

    if (messages.purged > 0) count(METRIC.RETENTION_MESSAGES_PURGED, messages.purged);
  }

  const metrics = await purgeMetrics(now);

  const truncated = events.truncated || messages.truncated;

  const result: PurgeResult = {
    webhookEvents: events.purged,
    messages: messages.purged,
    metricDays: metrics.days,
    metricKeys: metrics.keys,
    truncated,
  };

  if (truncated) {
    count(METRIC.RETENTION_TRUNCATED);
    log.warn('wa.retention.truncated', result);
  }

  /**
   * Counts only. A retention job that logged what it removed would keep, in the
   * log, exactly the content it was asked to destroy — and logs outlive records.
   */
  log.info('wa.retention.purged', {
    ...result,
    retentionWebhookEventDays: config.retentionWebhookEventDays(),
    retentionMessageMonths: months,
  });

  return result;
};

export const handler = async (): Promise<PurgeResult> => {
  try {
    return await purge();
  } catch (error) {
    logger.error('wa.retention.purge_failed', describeError(error));

    throw error;
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_RETENTION_PURGE,
  name: 'wa-retention-purge',
  description:
    'Deletes expired raw webhook events, empties message content past the retention window, and expires metric counters.',
  timeoutSeconds: 300,
  /**
   * 03:00, when nobody is messaging. The purge competes with the send path for
   * the Core API budget, and it is the only job in the app with no deadline.
   */
  cronTriggerSettings: { pattern: '0 3 * * *' },
  handler,
});
