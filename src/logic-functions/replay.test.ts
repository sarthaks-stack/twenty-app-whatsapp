import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WEBHOOK_PROCESSING_STATUS } from '../domain/constants';

/**
 * Replay (TRD §12.4, NFR-R1, specs/11 §6).
 *
 * The raw log is the only place a delivery can be reprocessed from — Meta
 * retries for seven days and has no replay endpoint — so the properties tested
 * here are the ones an operator's incident depends on.
 *
 * The most important is negative: a replay that cannot be enqueued must leave
 * the row `FAILED`. Marking it in flight first and then failing to queue
 * anything is the one state in which the event is gone from the failed list with
 * nothing scheduled to process it, and nobody would ever know.
 */

const enqueueAll = vi.fn();
const markWebhookEvent = vi.fn();
const accountForChange = vi.fn();
const jobsForChange = vi.fn();

vi.mock('../server/jobs', () => ({
  enqueueAll: (...args: unknown[]) => enqueueAll(...args),
}));

vi.mock('../server/repositories/webhook-events', () => ({
  markWebhookEvent: (...args: unknown[]) => markWebhookEvent(...args),
  countWebhookEvents: vi.fn(),
  findWebhookEventsByIds: vi.fn(),
  listWebhookEvents: vi.fn(),
}));

vi.mock('./wa-webhook-ingest', () => ({
  accountForChange: (...args: unknown[]) => accountForChange(...args),
  jobsForChange: (...args: unknown[]) => jobsForChange(...args),
}));

const {
  MAX_REPLAY_PER_REQUEST,
  parseDate,
  parseIds,
  parseLimit,
  parseStatuses,
  replayEvent,
} = await import('./wa-webhook-replay-route');

const EVENT = {
  id: 'ev1',
  dedupKey: 'msg:wamid.ABC',
  webhookField: 'messages',
  processingStatus: WEBHOOK_PROCESSING_STATUS.FAILED,
  payload: {
    field: 'messages',
    value: {
      metadata: { phone_number_id: '123' },
      messages: [{ id: 'wamid.ABC', type: 'text' }],
    },
    _entryId: 'waba1',
  },
};

beforeEach(() => {
  enqueueAll.mockReset();
  markWebhookEvent.mockReset();
  accountForChange.mockReset();
  jobsForChange.mockReset();

  accountForChange.mockResolvedValue({ id: 'acc1', phoneNumberId: '123' });
  jobsForChange.mockReturnValue([{ logicFunctionUniversalIdentifier: 'lf-inbound' }]);
  enqueueAll.mockResolvedValue(1);
});

describe('reading the request', () => {
  it('keeps only the statuses the log can hold', () => {
    expect(parseStatuses(['failed', 'PROCESSED', 'nonsense', 'FAILED'])).toEqual([
      'FAILED',
      'PROCESSED',
    ]);
    expect(parseStatuses('FAILED')).toEqual([]);
  });

  it('de-duplicates and trims event ids', () => {
    expect(parseIds([' ev1 ', 'ev1', '', 'ev2', 7])).toEqual(['ev1', 'ev2']);
    expect(parseIds(undefined)).toEqual([]);
  });

  /**
   * An unparseable date must not become "now" or the epoch: those bound a bulk
   * replay at nothing and at everything, and neither shows up in the count the
   * operator confirms.
   */
  it('reads an unusable date as no bound at all', () => {
    expect(parseDate('yesterday')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate(1_760_000_000_000)).toBeNull();
    expect(parseDate('2026-08-16T00:00:00.000Z')?.toISOString()).toBe(
      '2026-08-16T00:00:00.000Z',
    );
  });

  it('clamps a limit to the ceiling and never below one', () => {
    expect(parseLimit(10, 200)).toBe(10);
    expect(parseLimit(9_999, 200)).toBe(200);
    expect(parseLimit(0, 200)).toBe(200);
    expect(parseLimit('abc', 200)).toBe(200);
  });
});

describe('replaying one event', () => {
  it('re-drives the stored change through the live fan-out', async () => {
    const outcome = await replayEvent(EVENT as never);

    expect(outcome).toEqual({ eventId: 'ev1', replayed: true, jobs: 1 });

    /** The same routing table the live path uses — never a replay-only copy. */
    expect(jobsForChange).toHaveBeenCalledWith({
      change: { field: 'messages', value: EVENT.payload.value },
      webhookEventId: 'ev1',
      accountId: 'acc1',
      correlationId: 'msg:wamid.ABC',
    });

    expect(markWebhookEvent).toHaveBeenCalledWith('ev1', WEBHOOK_PROCESSING_STATUS.RECEIVED, null);
  });

  it('resolves the account from the payload, as ingest did', async () => {
    await replayEvent(EVENT as never);

    expect(accountForChange).toHaveBeenCalledWith(
      { id: 'waba1' },
      { field: 'messages', value: EVENT.payload.value },
    );
  });

  it('reads a payload stored as a JSON string', async () => {
    const outcome = await replayEvent({
      ...EVENT,
      payload: JSON.stringify(EVENT.payload),
    } as never);

    expect(outcome.replayed).toBe(true);
  });

  /**
   * The property the whole route rests on. An enqueue that lands nowhere must
   * leave the row `FAILED`, so it is still in the list the next replay reads.
   */
  it('leaves the row failed when nothing could be queued', async () => {
    enqueueAll.mockResolvedValue(0);

    const outcome = await replayEvent(EVENT as never);

    expect(outcome).toEqual({
      eventId: 'ev1',
      replayed: false,
      jobs: 0,
      reason: 'enqueue_failed',
    });

    expect(markWebhookEvent).not.toHaveBeenCalled();
  });

  it('refuses a change whose number belongs to no account here', async () => {
    accountForChange.mockResolvedValue(null);

    expect((await replayEvent(EVENT as never)).reason).toBe('foreign');
    expect(enqueueAll).not.toHaveBeenCalled();
  });

  /**
   * A field the app does not handle was already marked `PROCESSED` at ingest
   * with "unhandled field". Replaying it produces the same nothing, so it is
   * reported rather than counted as a success.
   */
  it('reports an unhandled field instead of claiming a replay', async () => {
    jobsForChange.mockReturnValue([]);

    expect((await replayEvent(EVENT as never)).reason).toBe('unhandled');
    expect(markWebhookEvent).not.toHaveBeenCalled();
  });

  it('reports a row whose payload is gone', async () => {
    expect((await replayEvent({ id: 'ev2', payload: null } as never)).reason).toBe(
      'no_payload',
    );
  });
});

describe('the blast radius', () => {
  /**
   * Not a performance cap. "Replay everything that failed this month" against a
   * week of a bad token is tens of thousands of jobs from one click, and the
   * operator who clicked cannot stop them.
   */
  it('caps one request well below a runaway', () => {
    expect(MAX_REPLAY_PER_REQUEST).toBeLessThanOrEqual(500);
    expect(MAX_REPLAY_PER_REQUEST).toBeGreaterThan(0);
  });
});
