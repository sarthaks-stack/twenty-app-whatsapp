import { OBJ_CAMPAIGN, OBJ_MESSAGE, OBJ_THREAD } from '../constants/universal-identifiers';
import { query } from './repositories/base';
import { config } from './config';
import { describeError, logger } from './logger';
import { resolveObjectMetadataId } from './metadata-ids';

/**
 * Timeline activities (FR-TL-1, D-9). The only writer.
 *
 * **Volume is the design constraint.** At 50 000 messages/day, one activity per
 * message is 50 000 rows/day on a table Twenty uses for its own purposes. So
 * `WA_TIMELINE_MODE` defaults to `SUMMARY`, which writes the events a person
 * reading a CRM record actually wants — the first message of a thread, every
 * template send, every failure, every consent or assignment change — and skips
 * the individual turns of an active back-and-forth. The full transcript lives
 * in the WhatsApp tab, which is where a rep reads it anyway.
 *
 * That is a deliberate deviation from a literal reading of FR-TL-1; the
 * requirement's intent, that a person's record shows their WhatsApp history, is
 * met by FR-UI-1 in every mode.
 */

export const TIMELINE_EVENT = {
  MESSAGE_RECEIVED: 'whatsapp.message.received',
  MESSAGE_SENT: 'whatsapp.message.sent',
  TEMPLATE_SENT: 'whatsapp.template.sent',
  MESSAGE_FAILED: 'whatsapp.message.failed',
  CONSENT_OPTED_IN: 'whatsapp.consent.opted_in',
  CONSENT_OPTED_OUT: 'whatsapp.consent.opted_out',
  THREAD_ASSIGNED: 'whatsapp.thread.assigned',
  THREAD_RELINKED: 'whatsapp.thread.relinked',
  CAMPAIGN_SENT: 'whatsapp.campaign.sent',
} as const;
export type TimelineEvent = (typeof TIMELINE_EVENT)[keyof typeof TIMELINE_EVENT];

export const TIMELINE_MODE = { ALL: 'ALL', SUMMARY: 'SUMMARY', OFF: 'OFF' } as const;

/**
 * In `SUMMARY` these are always written; everything else is written only in
 * `ALL`. Failures and consent changes are here because they are the events a
 * person looks back for, and a timeline that omitted them would be misleading
 * rather than merely sparse.
 */
const ALWAYS_IN_SUMMARY = new Set<string>([
  TIMELINE_EVENT.TEMPLATE_SENT,
  TIMELINE_EVENT.MESSAGE_FAILED,
  TIMELINE_EVENT.CONSENT_OPTED_IN,
  TIMELINE_EVENT.CONSENT_OPTED_OUT,
  TIMELINE_EVENT.THREAD_ASSIGNED,
  TIMELINE_EVENT.THREAD_RELINKED,
  TIMELINE_EVENT.CAMPAIGN_SENT,
]);

export const shouldWriteActivity = (
  event: TimelineEvent,
  { isFirstOfThread = false, mode = config.timelineMode() }: {
    isFirstOfThread?: boolean;
    mode?: string;
  } = {},
): boolean => {
  if (mode === TIMELINE_MODE.OFF) return false;
  if (mode === TIMELINE_MODE.ALL) return true;

  return ALWAYS_IN_SUMMARY.has(event) || isFirstOfThread;
};

export type TimelineActivityInput = {
  name: TimelineEvent;
  /** The domain event time, not the write time. */
  happensAt: Date;
  properties: Record<string, unknown>;
  targetPersonId: string | null;
  targetCompanyId?: string | null;
  linkedRecordId?: string | null;
  /** Universal identifier of the linked object; resolved and cached. */
  linkedObjectUniversalIdentifier?: string | null;
  linkedRecordCachedName?: string | null;
  isFirstOfThread?: boolean;
};

/**
 * Writing a timeline activity must never lose the message it describes, so
 * every failure here is swallowed and counted (specs/03 §4 step 9).
 */
export const writeTimelineActivity = async (
  input: TimelineActivityInput,
): Promise<boolean> => {
  if (!shouldWriteActivity(input.name, { isFirstOfThread: input.isFirstOfThread })) {
    return false;
  }

  if (input.targetPersonId === null) return false;

  try {
    const linkedObjectMetadataId =
      input.linkedObjectUniversalIdentifier === undefined ||
      input.linkedObjectUniversalIdentifier === null
        ? null
        : await resolveObjectMetadataId(input.linkedObjectUniversalIdentifier);

    await query(
      (client) =>
        client.mutation({
          createTimelineActivity: {
            __args: {
              data: {
                name: input.name,
                happensAt: input.happensAt.toISOString(),
                properties: input.properties,
                targetPersonId: input.targetPersonId,
                ...(input.targetCompanyId === null || input.targetCompanyId === undefined
                  ? {}
                  : { targetCompanyId: input.targetCompanyId }),
                ...(input.linkedRecordId === null || input.linkedRecordId === undefined
                  ? {}
                  : { linkedRecordId: input.linkedRecordId }),
                ...(linkedObjectMetadataId === null ? {} : { linkedObjectMetadataId }),
                ...(input.linkedRecordCachedName === null ||
                input.linkedRecordCachedName === undefined
                  ? {}
                  : { linkedRecordCachedName: input.linkedRecordCachedName }),
              },
            },
            id: true,
          },
        }),
      'timeline.create',
    );

    return true;
  } catch (error) {
    logger.warn('timeline.write_failed', { event: input.name, ...describeError(error) });

    return false;
  }
};

export const MESSAGE_OBJECT_UID = OBJ_MESSAGE;
export const THREAD_OBJECT_UID = OBJ_THREAD;
export const CAMPAIGN_OBJECT_UID = OBJ_CAMPAIGN;
