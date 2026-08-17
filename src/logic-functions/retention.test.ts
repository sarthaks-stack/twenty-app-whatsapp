import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Retention (SEC-9, specs/10 §4.2).
 *
 * The three properties worth failing a build over:
 *
 *  - **The floor holds.** Retention below seven days would discard events Meta
 *    is still redelivering, and this table is the only replay source there is.
 *  - **Zero months keeps everything.** The default is the reversible one, and a
 *    misread that treated `0` as "purge immediately" would silently empty every
 *    message in the workspace on the first nightly run.
 *  - **Reaching the cap is reported.** The window sweeper once returned its own
 *    pass limit as a success, so a growing backlog looked healthy for ever.
 */

const kvStore = new Map<string, unknown>();

vi.mock('twenty-sdk/logic-function', () => ({
  kv: {
    get: async (key: string) => kvStore.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      kvStore.set(key, value);
    },
    delete: async (key: string) => kvStore.delete(key),
  },
}));

const findExpiredWebhookEvents = vi.fn();
const destroyWebhookEvents = vi.fn();
const findPurgeableMessages = vi.fn();
const blankMessageContent = vi.fn();

vi.mock('../server/repositories/webhook-events', () => ({
  findExpiredWebhookEvents: (...args: unknown[]) => findExpiredWebhookEvents(...args),
  destroyWebhookEvents: (...args: unknown[]) => destroyWebhookEvents(...args),
}));

vi.mock('../server/repositories/messages', () => ({
  findPurgeableMessages: (...args: unknown[]) => findPurgeableMessages(...args),
  blankMessageContent: (...args: unknown[]) => blankMessageContent(...args),
}));

const { config } = await import('../server/config');
const {
  MAX_METRIC_DAYS_PER_RUN,
  MAX_PURGE_PASSES,
  METRIC_PURGE_MARKER,
  METRIC_RETENTION_DAYS,
  PURGE_BATCH,
  purge,
  purgeMetrics,
} = await import('./wa-retention-purge');

const ORIGINAL_ENV = { ...process.env };

const NOW = new Date('2026-08-17T03:00:00.000Z');

const rows = (count: number, prefix = 'r') =>
  Array.from({ length: count }, (_unused, index) => ({ id: `${prefix}${index}` }));

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  kvStore.clear();

  findExpiredWebhookEvents.mockReset();
  destroyWebhookEvents.mockReset();
  findPurgeableMessages.mockReset();
  blankMessageContent.mockReset();

  findExpiredWebhookEvents.mockResolvedValue([]);
  findPurgeableMessages.mockResolvedValue([]);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('the seven-day floor', () => {
  /**
   * Meta retries for seven days and offers no replay endpoint, so a shorter
   * window throws away deliveries that are still arriving.
   */
  it.each(['0', '1', '6', '-30'])('refuses %p and holds at seven days', (value) => {
    process.env.WA_RETENTION_WEBHOOK_EVENT_DAYS = value;

    expect(config.retentionWebhookEventDays()).toBe(7);
  });

  it('honours a longer window', () => {
    process.env.WA_RETENTION_WEBHOOK_EVENT_DAYS = '90';

    expect(config.retentionWebhookEventDays()).toBe(90);
  });
});

describe('purging the raw log', () => {
  it('destroys rows past the window and reports the count', async () => {
    findExpiredWebhookEvents.mockResolvedValueOnce(rows(4)).mockResolvedValue([]);

    const result = await purge(NOW);

    expect(result.webhookEvents).toBe(4);
    expect(result.truncated).toBe(false);
    expect(destroyWebhookEvents).toHaveBeenCalledWith(['r0', 'r1', 'r2', 'r3']);
  });

  it('cuts off at the configured window, not at some other date', async () => {
    process.env.WA_RETENTION_WEBHOOK_EVENT_DAYS = '30';

    await purge(NOW);

    const cutoff = findExpiredWebhookEvents.mock.calls[0]![0] as Date;

    expect(cutoff.toISOString()).toBe('2026-07-18T03:00:00.000Z');
  });

  /**
   * The failure the window sweeper had. A run that stops at its pass limit must
   * say so, or a backlog that grows for ever reports itself as healthy.
   */
  it('reports truncation rather than claiming it finished', async () => {
    findExpiredWebhookEvents.mockResolvedValue(rows(PURGE_BATCH));

    const result = await purge(NOW);

    expect(result.truncated).toBe(true);
    expect(result.webhookEvents).toBe(PURGE_BATCH * MAX_PURGE_PASSES);
  });
});

describe('purging message content', () => {
  it('keeps everything while the setting is zero', async () => {
    process.env.WA_RETENTION_MESSAGE_MONTHS = '0';

    const result = await purge(NOW);

    expect(result.messages).toBe(0);
    expect(findPurgeableMessages).not.toHaveBeenCalled();
    expect(blankMessageContent).not.toHaveBeenCalled();
  });

  it('empties messages older than the configured months', async () => {
    process.env.WA_RETENTION_MESSAGE_MONTHS = '6';
    findPurgeableMessages.mockResolvedValueOnce(rows(2, 'm')).mockResolvedValue([]);

    const result = await purge(NOW);

    expect(result.messages).toBe(2);
    expect(blankMessageContent).toHaveBeenCalledWith(['m0', 'm1']);

    const cutoff = findPurgeableMessages.mock.calls[0]![0] as Date;

    expect(cutoff.toISOString()).toBe('2026-02-17T03:00:00.000Z');
  });
});

describe('expiring counters', () => {
  /**
   * `kv` has no scan, so a first run that started at the cutoff would step over
   * every counter an existing workspace had already expired — unreachable for
   * ever, since nothing can enumerate them later.
   */
  it('starts a first run behind the cutoff so nothing is stranded', async () => {
    const { days } = await purgeMetrics(NOW);

    expect(days).toBe(MAX_METRIC_DAYS_PER_RUN);
    /** 90 days before the 2026-05-19 cutoff, then seven days of catch-up. */
    expect(kvStore.get(METRIC_PURGE_MARKER)).toBe('2026-02-24');
  });

  it('resumes from the marker rather than re-walking history', async () => {
    kvStore.set(METRIC_PURGE_MARKER, '2026-05-18');

    const { days } = await purgeMetrics(NOW);

    expect(days).toBe(1);
    expect(kvStore.get(METRIC_PURGE_MARKER)).toBe('2026-05-19');
  });

  /**
   * A cron that missed a week catches up over a week. The alternative — several
   * hundred `kv` deletes in one invocation — is how a catch-up run times out and
   * never catches up at all.
   */
  it('caps a long catch-up and continues on the next run', async () => {
    kvStore.set(METRIC_PURGE_MARKER, '2026-01-01');

    const first = await purgeMetrics(NOW);

    expect(first.days).toBe(MAX_METRIC_DAYS_PER_RUN);
    expect(kvStore.get(METRIC_PURGE_MARKER)).toBe('2026-01-08');

    const second = await purgeMetrics(NOW);

    expect(second.days).toBe(MAX_METRIC_DAYS_PER_RUN);
    expect(kvStore.get(METRIC_PURGE_MARKER)).toBe('2026-01-15');
  });

  it('does nothing once it has caught up to the window', async () => {
    kvStore.set(METRIC_PURGE_MARKER, '2026-05-19');

    const cutoff = new Date(NOW.getTime() - METRIC_RETENTION_DAYS * 24 * 3_600_000);

    expect(cutoff.toISOString().slice(0, 10)).toBe('2026-05-19');
    expect((await purgeMetrics(NOW)).days).toBe(0);
  });
});
