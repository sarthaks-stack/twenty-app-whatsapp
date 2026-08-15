import type {
  Direction,
  Lane,
  MessageStatus,
  MessageType,
  SourceKind,
  TemplateCategory,
} from '../../domain/constants';
import { nodesOf, query, type JsonObject } from './base';

/**
 * `whatsappMessage` — the high-volume table (NFR-S1: 50 000/day headroom).
 *
 * `wamid` carries a unique index and is the idempotency key for everything
 * downstream (AR-8): the same inbound message redelivered creates nothing, and
 * a status webhook finds its message by WAMID alone. Outbound records exist
 * with a null `wamid` only between `queued` and `accepted`.
 */

const MESSAGE_FIELDS = {
  id: true,
  wamid: true,
  direction: true,
  messageType: true,
  body: true,
  payload: true,
  status: true,
  statusTimestamps: true,
  errorCode: true,
  errorDetail: true,
  retryCount: true,
  templateParameters: true,
  templateName: true,
  templateLanguage: true,
  templateCategory: true,
  billableCostUsd: true,
  mediaMeta: true,
  contextWamid: true,
  reactionTargetWamid: true,
  waTimestamp: true,
  lane: true,
  sourceKind: true,
  threadId: true,
  templateId: true,
  sentById: true,
  clientToken: true,
  createdAt: true,
} as const;

export type WhatsappMessageRecord = {
  id: string;
  wamid?: string | null;
  direction?: string | null;
  messageType?: string | null;
  body?: string | null;
  payload?: JsonObject | null;
  status?: string | null;
  statusTimestamps?: JsonObject | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  retryCount?: number | null;
  templateParameters?: JsonObject | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateCategory?: string | null;
  billableCostUsd?: number | null;
  mediaMeta?: JsonObject | null;
  contextWamid?: string | null;
  reactionTargetWamid?: string | null;
  waTimestamp?: string | null;
  lane?: string | null;
  sourceKind?: string | null;
  threadId?: string | null;
  templateId?: string | null;
  sentById?: string | null;
  clientToken?: string | null;
  createdAt?: string | null;
};

export const findMessageByWamid = async (
  wamid: string,
): Promise<WhatsappMessageRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: { filter: { wamid: { eq: wamid } }, first: 1 },
          edges: { node: MESSAGE_FIELDS },
        },
      }),
    'messages.findByWamid',
  );

  return nodesOf<WhatsappMessageRecord>(result.whatsappMessages)[0] ?? null;
};

/**
 * One query for a batch of statuses.
 *
 * A status webhook can carry 50 WAMIDs; looking each up separately would make
 * one Meta delivery cost 50 Core API calls, which at campaign scale is the
 * whole budget (NFR-R2).
 */
export const findMessagesByWamids = async (
  wamids: string[],
): Promise<Map<string, WhatsappMessageRecord>> => {
  if (wamids.length === 0) return new Map();

  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: { filter: { wamid: { in: wamids } }, first: wamids.length },
          edges: { node: MESSAGE_FIELDS },
        },
      }),
    'messages.findByWamids',
  );

  return new Map(
    nodesOf<WhatsappMessageRecord>(result.whatsappMessages)
      .filter((message) => typeof message.wamid === 'string')
      .map((message) => [message.wamid!, message]),
  );
};

export const findMessageById = async (id: string): Promise<WhatsappMessageRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: { filter: { id: { eq: id } }, first: 1 },
          edges: { node: MESSAGE_FIELDS },
        },
      }),
    'messages.findById',
  );

  return nodesOf<WhatsappMessageRecord>(result.whatsappMessages)[0] ?? null;
};

/**
 * The newest inbound WAMID in a thread — what a read receipt marks.
 *
 * Meta marks that message *and everything before it* read, so one call clears
 * the whole conversation and sending one per unread message would be both
 * wasteful and wrong.
 */
export const findNewestInboundWamid = async (
  threadId: string,
): Promise<string | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: {
            filter: { threadId: { eq: threadId }, direction: { eq: 'INBOUND' } },
            orderBy: [{ waTimestamp: 'DescNullsLast' }],
            first: 1,
          },
          edges: { node: { id: true, wamid: true } },
        },
      }),
    'messages.findNewestInbound',
  );

  return nodesOf<{ wamid?: string | null }>(result.whatsappMessages)[0]?.wamid ?? null;
};

export type MessageCreateInput = {
  threadId: string;
  wamid?: string | null;
  direction: Direction;
  messageType: MessageType;
  body?: string | null;
  payload?: JsonObject | null;
  status: MessageStatus;
  statusTimestamps?: JsonObject | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  templateId?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateCategory?: TemplateCategory | null;
  templateParameters?: JsonObject | null;
  mediaMeta?: JsonObject | null;
  contextWamid?: string | null;
  reactionTargetWamid?: string | null;
  waTimestamp: string;
  lane: Lane;
  sourceKind: SourceKind;
  sentById?: string | null;
  clientToken?: string | null;
};

/**
 * The idempotency read behind FR-OUT-1.
 *
 * A double-clicked send button, or the sandbox retrying on a network blip,
 * arrives as two identical POSTs. The browser's token is what tells them apart
 * from two deliberate identical messages — which people genuinely send, so
 * de-duplicating on body text would be wrong.
 */
export const findMessageByClientToken = async (
  clientToken: string,
): Promise<WhatsappMessageRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: { filter: { clientToken: { eq: clientToken } }, first: 1 },
          edges: { node: MESSAGE_FIELDS },
        },
      }),
    'messages.findByClientToken',
  );

  return nodesOf<WhatsappMessageRecord>(result.whatsappMessages)[0] ?? null;
};

/**
 * Outbound messages that never left (NFR-R3).
 *
 * A `QUEUED` row with no WAMID older than the grace period means its sender
 * job died between the record write and the Meta call — a worker restart, an
 * OOM, a deploy. Nothing else would ever move it, so the hourly health check
 * re-enqueues it once and then fails it explicitly rather than leaving it in a
 * limbo that looks like "sending…" forever.
 */
export const findStuckQueuedMessages = async (
  olderThan: Date,
  limit = 60,
): Promise<WhatsappMessageRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: {
            filter: {
              status: { eq: 'QUEUED' },
              direction: { eq: 'OUTBOUND' },
              createdAt: { lt: olderThan.toISOString() },
            },
            first: limit,
          },
          edges: { node: MESSAGE_FIELDS },
        },
      }),
    'messages.findStuckQueued',
  );

  return nodesOf<WhatsappMessageRecord>(result.whatsappMessages);
};

export const createMessage = async (
  input: MessageCreateInput,
): Promise<WhatsappMessageRecord> => {
  const result = await query(
    (client) =>
      client.mutation({
        createWhatsappMessage: { __args: { data: input }, ...MESSAGE_FIELDS },
      }),
    'messages.create',
  );

  return result.createWhatsappMessage as WhatsappMessageRecord;
};

/**
 * A FILES column takes `{ fileId, label }`, not the object `uploadFile`
 * returns. Passing the upload result straight through is accepted by the type
 * checker only if the field is typed loosely, and rejected by the server at
 * runtime — so the shape is named here.
 */
export type FileItemInput = { fileId: string; label: string };

export type MessagePatch = {
  wamid?: string | null;
  mediaFile?: FileItemInput[];
  status?: MessageStatus;
  statusTimestamps?: JsonObject | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  retryCount?: number;
  billableCostUsd?: number | null;
  mediaMeta?: JsonObject | null;
  payload?: JsonObject | null;
  body?: string | null;
};

export const patchMessage = async (id: string, data: MessagePatch): Promise<void> => {
  await query(
    (client) => client.mutation({ updateWhatsappMessage: { __args: { id, data }, id: true } }),
    'messages.patch',
  );
};
