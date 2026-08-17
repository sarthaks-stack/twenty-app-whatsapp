import type { WebhookProcessingStatus } from '../../domain/constants';
import { isUniqueViolation } from '../batching';
import { nodesOf, pageOf, query, type JsonObject } from './base';

/**
 * `whatsappWebhookEvent` — the raw log, the replay surface and the duplicate
 * suppressor (AR-7, D-12).
 *
 * Meta offers no replay API beyond its own 7-day retry, so this table is the
 * only way to reprocess history — which is why retention below 7 days is
 * rejected by config validation and why nothing is ever discarded before a row
 * exists (NFR-R1).
 */

const EVENT_FIELDS = {
  id: true,
  dedupKey: true,
  webhookField: true,
  payload: true,
  processingStatus: true,
  error: true,
  attemptCount: true,
  receivedAt: true,
  processedAt: true,
} as const;

export type WhatsappWebhookEventRecord = {
  id: string;
  dedupKey?: string | null;
  webhookField?: string | null;
  payload?: JsonObject | null;
  processingStatus?: string | null;
  error?: string | null;
  attemptCount?: number | null;
  receivedAt?: string | null;
  processedAt?: string | null;
};

export type RecordEventResult =
  | { created: true; event: WhatsappWebhookEventRecord }
  | { created: false; reason: 'duplicate' };

/**
 * Creates the raw row, treating a unique-index collision as the *expected*
 * outcome of a Meta redelivery rather than as an error.
 *
 * The collision is the deduplication. Checking for existence first and then
 * inserting would leave a window in which two concurrent deliveries both see
 * "not present" — the database constraint has no such window, which is why the
 * design leans on it instead of on a read (D-12).
 */
export const recordWebhookEvent = async (input: {
  dedupKey: string;
  webhookField: string;
  payload: JsonObject;
}): Promise<RecordEventResult> => {
  try {
    const result = await query(
      (client) =>
        client.mutation({
          createWhatsappWebhookEvent: {
            __args: {
              data: {
                dedupKey: input.dedupKey,
                webhookField: input.webhookField,
                payload: input.payload,
                processingStatus: 'RECEIVED',
              },
            },
            ...EVENT_FIELDS,
          },
        }),
      'webhookEvents.create',
    );

    return { created: true, event: result.createWhatsappWebhookEvent as WhatsappWebhookEventRecord };
  } catch (error) {
    if (isUniqueViolation(error)) return { created: false, reason: 'duplicate' };

    throw error;
  }
};

export const markWebhookEvent = async (
  id: string,
  processingStatus: WebhookProcessingStatus,
  error?: string | null,
): Promise<void> => {
  await query(
    (client) =>
      client.mutation({
        updateWhatsappWebhookEvent: {
          __args: {
            id,
            data: {
              processingStatus,
              processedAt: new Date().toISOString(),
              ...(error === undefined ? {} : { error }),
            },
          },
          id: true,
        },
      }),
    'webhookEvents.mark',
  );
};

/**
 * Records a failure *and* advances the attempt counter, so an admin looking at
 * the replay list can tell "failed once, transient" from "failed four times,
 * needs a human".
 */
export const markWebhookEventFailed = async (
  id: string,
  attemptCount: number,
  error: string,
): Promise<void> => {
  await query(
    (client) =>
      client.mutation({
        updateWhatsappWebhookEvent: {
          __args: {
            id,
            data: {
              processingStatus: 'FAILED',
              processedAt: new Date().toISOString(),
              attemptCount: attemptCount + 1,
              error: error.slice(0, 2_000),
            },
          },
          id: true,
        },
      }),
    'webhookEvents.markFailed',
  );
};

export const findWebhookEventById = async (
  id: string,
): Promise<WhatsappWebhookEventRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappWebhookEvents: {
          __args: { filter: { id: { eq: id } }, first: 1 },
          edges: { node: EVENT_FIELDS },
        },
      }),
    'webhookEvents.findById',
  );

  return nodesOf<WhatsappWebhookEventRecord>(result.whatsappWebhookEvents)[0] ?? null;
};

export const findFailedWebhookEvents = async (
  limit = 60,
): Promise<WhatsappWebhookEventRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappWebhookEvents: {
          __args: { filter: { processingStatus: { eq: 'FAILED' } }, first: limit },
          edges: { node: EVENT_FIELDS },
        },
      }),
    'webhookEvents.findFailed',
  );

  return nodesOf<WhatsappWebhookEventRecord>(result.whatsappWebhookEvents);
};

export const findWebhookEventsByIds = async (
  ids: string[],
): Promise<WhatsappWebhookEventRecord[]> => {
  if (ids.length === 0) return [];

  const result = await query(
    (client) =>
      client.query({
        whatsappWebhookEvents: {
          __args: { filter: { id: { in: ids } }, first: ids.length },
          edges: { node: EVENT_FIELDS },
        },
      }),
    'webhookEvents.findByIds',
  );

  return nodesOf<WhatsappWebhookEventRecord>(result.whatsappWebhookEvents);
};

export type WebhookEventQuery = {
  statuses?: WebhookProcessingStatus[];
  since?: Date | null;
  until?: Date | null;
  /**
   * A substring of the serialised payload — a `wa_id` or a WAMID.
   *
   * `payload` is RAW_JSON and the schema exposes only `like` on it, so this is a
   * scan over serialised JSON rather than an indexed lookup. It is deliberately
   * only reachable from the admin diagnostics surface, always bounded by a date
   * window and a limit, and never on any hot path.
   */
  payloadContains?: string | null;
  limit?: number;
  after?: string | null;
};

const filterFor = ({ statuses, since, until, payloadContains }: WebhookEventQuery) => {
  const hasSince = since !== null && since !== undefined;
  const hasUntil = until !== null && until !== undefined;

  const receivedAt = {
    ...(hasSince ? { gte: since.toISOString() } : {}),
    ...(hasUntil ? { lte: until.toISOString() } : {}),
  };

  return {
    ...(statuses === undefined || statuses.length === 0
      ? {}
      : { processingStatus: { in: statuses } }),
    ...(hasSince || hasUntil ? { receivedAt } : {}),
    ...(payloadContains === null ||
    payloadContains === undefined ||
    payloadContains.length === 0
      ? {}
      : { payload: { like: `%${payloadContains}%` } }),
  };
};

/**
 * One page of the raw log, newest first.
 *
 * Newest first because an operator reading this list is looking at an incident
 * that just happened. The purge reads the other direction with its own query,
 * since "the oldest 200 rows" is a different question from "what broke".
 */
export const listWebhookEvents = async (
  input: WebhookEventQuery = {},
): Promise<{ items: WhatsappWebhookEventRecord[]; nextCursor: string | null }> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappWebhookEvents: {
          __args: {
            filter: filterFor(input),
            orderBy: [{ receivedAt: 'DescNullsLast' }],
            first: input.limit ?? 60,
            ...(input.after === null || input.after === undefined ? {} : { after: input.after }),
          },
          edges: { node: EVENT_FIELDS },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    'webhookEvents.list',
  );

  return pageOf<WhatsappWebhookEventRecord>(result.whatsappWebhookEvents);
};

/**
 * How many rows a filter matches, without reading them.
 *
 * "Replay all failed in the last 24 hours" needs a number *before* it needs
 * rows: an operator confirming a bulk replay is entitled to know whether they
 * are re-driving nine events or nine thousand (specs/11 §6).
 */
export const countWebhookEvents = async (input: WebhookEventQuery = {}): Promise<number> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappWebhookEvents: {
          __args: { filter: filterFor(input), first: 0 },
          totalCount: true,
        },
      }),
    'webhookEvents.count',
  );

  return result.whatsappWebhookEvents?.totalCount ?? 0;
};

/**
 * The oldest page of rows a retention window has passed, id-ordered.
 *
 * Ordered by id rather than by date because the purge deletes what it reads:
 * without a total order the API may return a row twice or not at all across
 * pages, and "not at all" here means a row that survives every future run.
 */
export const findExpiredWebhookEvents = async (
  before: Date,
  limit: number,
): Promise<{ id: string }[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappWebhookEvents: {
          __args: {
            filter: { receivedAt: { lt: before.toISOString() } },
            orderBy: [{ id: 'AscNullsFirst' }],
            first: limit,
          },
          edges: { node: { id: true } },
        },
      }),
    'webhookEvents.findExpired',
  );

  return nodesOf<{ id: string }>(result.whatsappWebhookEvents);
};

/**
 * A **hard** delete, and the reason is the unique index on `dedupKey`.
 *
 * A soft-deleted row keeps its indexed value (probe P-4 is still unanswered, so
 * this assumes the unfavourable answer). If Meta redelivered a change whose
 * dedup key belonged to a soft-deleted row, the insert would collide and the
 * event would be discarded as a duplicate — for ever, with nothing to replay it
 * from. The purge therefore destroys, and `architecture.test.ts` names this
 * module as the second permitted caller for exactly this reason.
 */
export const destroyWebhookEvents = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;

  await query(
    (client) =>
      client.mutation({
        destroyWhatsappWebhookEvents: { __args: { filter: { id: { in: ids } } }, id: true },
      }),
    'webhookEvents.destroy',
  );
};
