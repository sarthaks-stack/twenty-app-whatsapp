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
        whatsappMessage: { __args: { filter: { id: { eq: id } } }, ...MESSAGE_FIELDS },
      }),
    'messages.findById',
  );

  return (result.whatsappMessage as WhatsappMessageRecord | null) ?? null;
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
