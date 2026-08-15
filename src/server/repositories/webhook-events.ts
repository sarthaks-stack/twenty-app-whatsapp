import type { WebhookProcessingStatus } from '../../domain/constants';
import { isUniqueViolation } from '../batching';
import { nodesOf, query, type JsonObject } from './base';

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
