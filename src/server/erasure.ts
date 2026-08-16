import { CONSENT_METHOD } from '../domain/constants';
import { inBatches } from './batching';
import { describeError, logger } from './logger';
import { METRIC, count } from './metrics';
import { nodesOf, query } from './repositories/base';
import { createConsentEvent } from './repositories/consent-events';
import { writeTimelineActivity, TIMELINE_EVENT } from './timeline';

/**
 * Subject erasure (SEC-8, specs/10 §4.1).
 *
 * The hard part of an erasure is not deleting things — it is being able to
 * prove afterwards that it happened, to someone asking months later, without
 * retaining the content that was erased. So the consent trail is not deleted
 * but *replaced by a single tombstone*: who erased, when, and how many events
 * were removed, with no wording, no phone number and no message body.
 *
 * Deletion is **hard**, not soft. A soft-deleted row still holds the content,
 * so "deleted" would be a description of a flag rather than of the data.
 *
 * The Person record itself is left alone: Twenty owns that lifecycle, and an
 * app that deleted a CRM contact as a side effect of clearing its own data
 * would be doing something nobody asked for.
 */

export type ErasureCounts = {
  threads: number;
  messages: number;
  consentEvents: number;
  campaignRecipients: number;
  mediaFiles: number;
};

export type ErasureResult = ErasureCounts & {
  dryRun: boolean;
  personId: string;
};

const idsOf = (records: { id: string }[]): string[] => records.map((record) => record.id);

/**
 * Everything the erasure would touch, counted before anything is destroyed.
 *
 * The route exposes this as a dry run so an operator sees the blast radius
 * before confirming — an erasure is the one action in this app with no undo,
 * and "19 messages across 1 conversation" is a very different decision from
 * "4 200 messages across 37".
 */
export const collectErasureTargets = async (
  personId: string,
): Promise<{
  threadIds: string[];
  messageIds: string[];
  consentEventIds: string[];
  recipientIds: string[];
  mediaFileCount: number;
}> => {
  const threads = await query(
    (client) =>
      client.query({
        whatsappThreads: {
          __args: { filter: { personId: { eq: personId } }, first: 200 },
          edges: { node: { id: true } },
        },
      }),
    'erasure.threads',
  );

  const threadIds = idsOf(nodesOf<{ id: string }>(threads.whatsappThreads));

  const messages =
    threadIds.length === 0
      ? []
      : nodesOf<{ id: string; mediaFile?: { fileId?: string }[] | null }>(
          (
            await query(
              (client) =>
                client.query({
                  whatsappMessages: {
                    __args: { filter: { threadId: { in: threadIds } }, first: 1000 },
                    edges: { node: { id: true, mediaFile: { fileId: true } } },
                  },
                }),
              'erasure.messages',
            )
          ).whatsappMessages ?? null,
        );

  const consentEvents = await query(
    (client) =>
      client.query({
        whatsappConsentEvents: {
          __args: { filter: { personId: { eq: personId } }, first: 500 },
          edges: { node: { id: true } },
        },
      }),
    'erasure.consentEvents',
  );

  const recipients = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: { filter: { personId: { eq: personId } }, first: 500 },
          edges: { node: { id: true } },
        },
      }),
    'erasure.recipients',
  );

  return {
    threadIds,
    messageIds: idsOf(messages),
    consentEventIds: idsOf(nodesOf<{ id: string }>(consentEvents.whatsappConsentEvents)),
    recipientIds: idsOf(nodesOf<{ id: string }>(recipients.whatsappCampaignRecipients)),
    mediaFileCount: messages.filter(
      (message) => Array.isArray(message.mediaFile) && message.mediaFile.length > 0,
    ).length,
  };
};

export const erasePerson = async ({
  personId,
  actorId,
  dryRun = false,
}: {
  personId: string;
  actorId: string | null;
  dryRun?: boolean;
}): Promise<ErasureResult> => {
  const log = logger.child({ fn: 'erasure', correlationId: personId });

  const targets = await collectErasureTargets(personId);

  const counts: ErasureCounts = {
    threads: targets.threadIds.length,
    messages: targets.messageIds.length,
    consentEvents: targets.consentEventIds.length,
    campaignRecipients: targets.recipientIds.length,
    mediaFiles: targets.mediaFileCount,
  };

  if (dryRun) return { ...counts, dryRun: true, personId };

  /**
   * Messages before threads. The other order would leave orphaned messages if
   * the second call failed, and an orphaned message is content that survived an
   * erasure with nothing pointing at it — the worst of both outcomes.
   */
  await inBatches(
    targets.messageIds,
    (batch) =>
      query(
        (client) =>
          client.mutation({
            destroyWhatsappMessages: { __args: { filter: { id: { in: batch } } }, id: true },
          }),
        'erasure.destroyMessages',
      ),
    { label: 'erasure.destroyMessages' },
  );

  await inBatches(
    targets.threadIds,
    (batch) =>
      query(
        (client) =>
          client.mutation({
            destroyWhatsappThreads: { __args: { filter: { id: { in: batch } } }, id: true },
          }),
        'erasure.destroyThreads',
      ),
    { label: 'erasure.destroyThreads' },
  );

  /**
   * Campaign recipient rows go too. They record that this person was targeted,
   * which is exactly the kind of profiling record an erasure request is about —
   * and the campaign's own counters are a separate, aggregate fact that the
   * rollup keeps.
   */
  await inBatches(
    targets.recipientIds,
    (batch) =>
      query(
        (client) =>
          client.mutation({
            destroyWhatsappCampaignRecipients: {
              __args: { filter: { id: { in: batch } } },
              id: true,
            },
          }),
        'erasure.destroyRecipients',
      ),
    { label: 'erasure.destroyRecipients' },
  );

  await inBatches(
    targets.consentEventIds,
    (batch) =>
      query(
        (client) =>
          client.mutation({
            destroyWhatsappConsentEvents: {
              __args: { filter: { id: { in: batch } } },
              id: true,
            },
          }),
        'erasure.destroyConsentEvents',
      ),
    { label: 'erasure.destroyConsentEvents' },
  );

  /**
   * The tombstone. It is the compromise between "erase everything" and "prove
   * the erasure happened", and it is what an auditor actually asks for. It
   * carries counts and an actor — never wording, a number, or a message.
   */
  try {
    await createConsentEvent({
      personId,
      newStatus: null,
      previousStatus: null,
      method: CONSENT_METHOD.MANUAL,
      wordingShown: null,
      sourceReference: null,
      notes: `Erased ${counts.consentEvents} consent events, ${counts.messages} messages and ${counts.threads} conversations`,
      actorId,
      occurredAt: new Date(),
      isTombstone: true,
    });
  } catch (error) {
    log.error('wa.erasure.tombstone_failed', describeError(error));
  }

  await writeTimelineActivity({
    name: TIMELINE_EVENT.DATA_ERASED,
    happensAt: new Date(),
    properties: { ...counts, actorId },
    targetPersonId: personId,
  });

  count(METRIC.ERASURE_COMPLETED);
  log.warn('wa.erasure.completed', { ...counts, actorId });

  return { ...counts, dryRun: false, personId };
};
