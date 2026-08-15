import type { ExclusionReason, RecipientStatus } from '../../domain/constants';
import { inBatches } from '../batching';
import { nodesOf, query, type JsonObject } from './base';

/**
 * `whatsappCampaignRecipient` — the snapshot row and the unit of idempotency
 * (AR-20, FR-CAM-9).
 *
 * Ingestion touches this only to mirror a delivery status back from the
 * message, and to mark a recipient `RESPONDED` when they reply (FR-CAM-13).
 * Snapshot and claim writes belong to the campaign phase.
 */

const RECIPIENT_FIELDS = {
  id: true,
  status: true,
  exclusionReason: true,
  resolvedParameters: true,
  resolvedPhone: true,
  errorCode: true,
  errorDetail: true,
  claimedAt: true,
  campaignId: true,
  personId: true,
  threadId: true,
  messageId: true,
} as const;

export type WhatsappCampaignRecipientRecord = {
  id: string;
  status?: string | null;
  exclusionReason?: string | null;
  resolvedParameters?: JsonObject | null;
  resolvedPhone?: string | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  claimedAt?: string | null;
  campaignId?: string | null;
  personId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
};

export const findRecipientByMessageId = async (
  messageId: string,
): Promise<WhatsappCampaignRecipientRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: { filter: { messageId: { eq: messageId } }, first: 1 },
          edges: { node: RECIPIENT_FIELDS },
        },
      }),
    'recipients.findByMessageId',
  );

  return nodesOf<WhatsappCampaignRecipientRecord>(result.whatsappCampaignRecipients)[0] ?? null;
};

export const findRecipientsByMessageIds = async (
  messageIds: string[],
): Promise<Map<string, WhatsappCampaignRecipientRecord>> => {
  if (messageIds.length === 0) return new Map();

  const result = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: { filter: { messageId: { in: messageIds } }, first: messageIds.length },
          edges: { node: RECIPIENT_FIELDS },
        },
      }),
    'recipients.findByMessageIds',
  );

  return new Map(
    nodesOf<WhatsappCampaignRecipientRecord>(result.whatsappCampaignRecipients)
      .filter((recipient) => typeof recipient.messageId === 'string')
      .map((recipient) => [recipient.messageId!, recipient]),
  );
};

export const findRecipientByThreadId = async (
  campaignId: string,
  threadId: string,
): Promise<WhatsappCampaignRecipientRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: {
            filter: { campaignId: { eq: campaignId }, threadId: { eq: threadId } },
            first: 1,
          },
          edges: { node: RECIPIENT_FIELDS },
        },
      }),
    'recipients.findByThreadId',
  );

  return nodesOf<WhatsappCampaignRecipientRecord>(result.whatsappCampaignRecipients)[0] ?? null;
};

/**
 * Recipients claimed by a runner tick that never sent them (specs/07 §6.1).
 *
 * A claim is a lease, not a lock: the runner that took it may have died
 * mid-tick. Without this sweep those rows would sit `CLAIMED` forever and the
 * campaign would report itself running while sending nothing — the failure mode
 * that looks most like success.
 */
export const findStaleClaimedRecipients = async (
  claimedBefore: Date,
  limit = 60,
): Promise<WhatsappCampaignRecipientRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: {
            filter: {
              status: { eq: 'CLAIMED' },
              claimedAt: { lt: claimedBefore.toISOString() },
            },
            first: limit,
          },
          edges: { node: RECIPIENT_FIELDS },
        },
      }),
    'recipients.findStaleClaims',
  );

  return nodesOf<WhatsappCampaignRecipientRecord>(result.whatsappCampaignRecipients);
};

export type RecipientPatch = {
  status?: RecipientStatus;
  exclusionReason?: ExclusionReason | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  claimedAt?: string | null;
  threadId?: string | null;
  messageId?: string | null;
};

export const patchRecipient = async (id: string, data: RecipientPatch): Promise<void> => {
  await query(
    (client) =>
      client.mutation({ updateWhatsappCampaignRecipient: { __args: { id, data }, id: true } }),
    'recipients.patch',
  );
};

/**
 * Applies one patch to many recipients, chunked at 60.
 *
 * A status webhook carrying 50 recipient transitions would otherwise cost 50
 * mutations — the whole per-minute budget for one Meta delivery (NFR-R2, 03
 * §5.2). Recipients sharing a target status are grouped by the caller.
 */
export const patchRecipients = async (
  ids: string[],
  data: RecipientPatch,
): Promise<void> => {
  if (ids.length === 0) return;

  await inBatches(
    ids,
    (batch) =>
      query(
        (client) =>
          client.mutation({
            updateWhatsappCampaignRecipients: {
              __args: { data, filter: { id: { in: batch } } },
              id: true,
            },
          }),
        'recipients.patchMany',
      ),
    { label: 'recipients.patchMany' },
  );
};
