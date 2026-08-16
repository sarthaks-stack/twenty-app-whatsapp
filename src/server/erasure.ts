import { CONSENT_METHOD, CONSENT_STATUS } from '../domain/constants';
import { inBatches } from './batching';
import { describeError, logger } from './logger';
import { METRIC, count } from './metrics';
import { pageOf, query } from './repositories/base';
import { createConsentEvent } from './repositories/consent-events';
import { findPersonById, patchPersonConsent } from './repositories/people';
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

export type ErasureTargets = {
  threadIds: string[];
  messageIds: string[];
  consentEventIds: string[];
  recipientIds: string[];
  mediaFileCount: number;
};

const idsOf = (records: { id: string }[]): string[] => records.map((record) => record.id);

export const ERASURE_PAGE_SIZE = 200;

/**
 * A safety valve, not a budget: 2 000 pages is 400 000 records of a single kind
 * for a single person. Reaching it means the cursor is not advancing — a bug —
 * and looping forever inside a route is worse than stopping.
 */
export const MAX_ERASURE_PAGES = 2_000;

/**
 * Raised when the enumeration could not be finished.
 *
 * It exists so that a partial erasure is *never* reported as a completed one.
 * The failure mode this class rules out is the dangerous one: deleting the
 * first page, writing a tombstone that says the person was erased, and leaving
 * the rest of their messages in the workspace with a receipt claiming
 * otherwise. An error the operator sees is recoverable; a false receipt is not.
 */
export class ErasureIncompleteError extends Error {
  constructor(readonly kind: string) {
    super(`Could not enumerate all ${kind} within ${MAX_ERASURE_PAGES} pages`);
    this.name = 'ErasureIncompleteError';
  }
}

/**
 * Reads every page of a connection, not the first one.
 *
 * Ordering by id is what makes the cursor stable: without a total order the
 * API is free to return a row twice or not at all across pages, and "not at
 * all" during an erasure means content that survives.
 */
const collectAll = async <T>(
  kind: string,
  readPage: (after: string | null) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> => {
  const all: T[] = [];
  let after: string | null = null;

  for (let page = 0; page < MAX_ERASURE_PAGES; page += 1) {
    const { items, nextCursor } = await readPage(after);

    all.push(...items);

    if (nextCursor === null) return all;

    after = nextCursor;
  }

  throw new ErasureIncompleteError(kind);
};

const readThreadPage = async (personId: string, after: string | null) =>
  pageOf<{ id: string }>(
    (
      await query(
        (client) =>
          client.query({
            whatsappThreads: {
              __args: {
                filter: { personId: { eq: personId } },
                orderBy: [{ id: 'AscNullsFirst' }],
                first: ERASURE_PAGE_SIZE,
                ...(after === null ? {} : { after }),
              },
              edges: { node: { id: true } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          }),
        'erasure.threads',
      )
    ).whatsappThreads,
  );

type MessageRow = { id: string; mediaFile?: { fileId?: string }[] | null };

const readMessagePage = async (threadIds: string[], after: string | null) =>
  pageOf<MessageRow>(
    (
      await query(
        (client) =>
          client.query({
            whatsappMessages: {
              __args: {
                filter: { threadId: { in: threadIds } },
                orderBy: [{ id: 'AscNullsFirst' }],
                first: ERASURE_PAGE_SIZE,
                ...(after === null ? {} : { after }),
              },
              edges: { node: { id: true, mediaFile: { fileId: true } } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          }),
        'erasure.messages',
      )
    ).whatsappMessages,
  );

/**
 * Tombstones from earlier erasures are left alone.
 *
 * They hold no content — counts and an actor — and destroying them would mean
 * a second erasure quietly deleting the proof that the first one happened,
 * which is the one thing this module exists to keep.
 */
const readConsentEventPage = async (personId: string, after: string | null) =>
  pageOf<{ id: string }>(
    (
      await query(
        (client) =>
          client.query({
            whatsappConsentEvents: {
              __args: {
                filter: {
                  personId: { eq: personId },
                  or: [{ isTombstone: { eq: false } }, { isTombstone: { is: 'NULL' } }],
                },
                orderBy: [{ id: 'AscNullsFirst' }],
                first: ERASURE_PAGE_SIZE,
                ...(after === null ? {} : { after }),
              },
              edges: { node: { id: true } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          }),
        'erasure.consentEvents',
      )
    ).whatsappConsentEvents,
  );

const readRecipientPage = async (personId: string, after: string | null) =>
  pageOf<{ id: string }>(
    (
      await query(
        (client) =>
          client.query({
            whatsappCampaignRecipients: {
              __args: {
                filter: { personId: { eq: personId } },
                orderBy: [{ id: 'AscNullsFirst' }],
                first: ERASURE_PAGE_SIZE,
                ...(after === null ? {} : { after }),
              },
              edges: { node: { id: true } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          }),
        'erasure.recipients',
      )
    ).whatsappCampaignRecipients,
  );

/**
 * Everything the erasure would touch, counted before anything is destroyed.
 *
 * The route exposes this as a dry run so an operator sees the blast radius
 * before confirming — an erasure is the one action in this app with no undo,
 * and "19 messages across 1 conversation" is a very different decision from
 * "4 200 messages across 37".
 *
 * Every read here pages to exhaustion. An earlier version took one page of each
 * kind and treated it as the whole set, which meant a contact with more than a
 * page of history had the oldest part of it kept — while the erasure reported
 * success and wrote a tombstone saying it was gone (D-24).
 */
export const collectErasureTargets = async (personId: string): Promise<ErasureTargets> => {
  const threadIds = idsOf(
    await collectAll('threads', (after) => readThreadPage(personId, after)),
  );

  const messages =
    threadIds.length === 0
      ? []
      : await collectAll<MessageRow>('messages', (after) => readMessagePage(threadIds, after));

  const consentEventIds = idsOf(
    await collectAll('consent events', (after) => readConsentEventPage(personId, after)),
  );

  const recipientIds = idsOf(
    await collectAll('campaign recipients', (after) => readRecipientPage(personId, after)),
  );

  return {
    threadIds,
    messageIds: idsOf(messages),
    consentEventIds,
    recipientIds,
    mediaFileCount: messages.filter(
      (message) => Array.isArray(message.mediaFile) && message.mediaFile.length > 0,
    ).length,
  };
};

/**
 * One pass of destruction over an already-enumerated set.
 *
 * Messages before threads. The other order would leave orphaned messages if
 * the second call failed, and an orphaned message is content that survived an
 * erasure with nothing pointing at it — the worst of both outcomes.
 *
 * Campaign recipient rows go too. They record that this person was targeted,
 * which is exactly the kind of profiling record an erasure request is about —
 * and the campaign's own counters are a separate, aggregate fact that the
 * rollup keeps.
 */
const destroyTargets = async (targets: ErasureTargets): Promise<void> => {
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
};

const isEmpty = (targets: ErasureTargets): boolean =>
  targets.threadIds.length === 0 &&
  targets.messageIds.length === 0 &&
  targets.consentEventIds.length === 0 &&
  targets.recipientIds.length === 0;

const addTo = (counts: ErasureCounts, targets: ErasureTargets): ErasureCounts => ({
  threads: counts.threads + targets.threadIds.length,
  messages: counts.messages + targets.messageIds.length,
  consentEvents: counts.consentEvents + targets.consentEventIds.length,
  campaignRecipients: counts.campaignRecipients + targets.recipientIds.length,
  mediaFiles: counts.mediaFiles + targets.mediaFileCount,
});

/**
 * How many times the erasure re-reads the workspace looking for stragglers.
 *
 * More than one because an inbound message can land mid-erasure: the webhook
 * that creates it does not know an erasure is running, and a row created after
 * the enumeration but before the tombstone would otherwise outlive an erasure
 * that claims to have removed it.
 */
export const MAX_ERASURE_ROUNDS = 3;

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

  const first = await collectErasureTargets(personId);

  let counts: ErasureCounts = {
    threads: 0,
    messages: 0,
    consentEvents: 0,
    campaignRecipients: 0,
    mediaFiles: 0,
  };

  if (dryRun) return { ...addTo(counts, first), dryRun: true, personId };

  /**
   * Delete, then look again, and only stop when a fresh read comes back empty.
   * The re-read is what lets the tombstone be a statement of fact rather than
   * of intent: it is written after the workspace has been observed clean, not
   * after the delete calls returned.
   */
  let targets = first;
  let clean = false;

  for (let round = 0; round < MAX_ERASURE_ROUNDS && !clean; round += 1) {
    await destroyTargets(targets);

    counts = addTo(counts, targets);

    targets = await collectErasureTargets(personId);
    clean = isEmpty(targets);

    if (!clean) {
      log.warn('wa.erasure.residue', {
        round: round + 1,
        threads: targets.threadIds.length,
        messages: targets.messageIds.length,
        consentEvents: targets.consentEventIds.length,
        campaignRecipients: targets.recipientIds.length,
      });
    }
  }

  /**
   * Nothing is recorded if the workspace is not clean. The counts so far are
   * real — those rows are gone — but a tombstone and a `DATA_ERASED` activity
   * both assert something stronger than "most of it", and the caller needs to
   * see a failure rather than a receipt.
   */
  if (!clean) {
    count(METRIC.ERASURE_FAILED);
    log.error('wa.erasure.incomplete', { ...counts, actorId });

    throw new ErasureIncompleteError('records');
  }

  /**
   * The denormalised consent status is reset with the evidence. The events
   * behind it are gone, so a Person left `OPTED_IN` would be an unauditable
   * claim — and, worse, would keep an "erased" contact selectable for the
   * next campaign. Uncaught on purpose: if this write fails the erasure must
   * fail rather than hand back a receipt for a person who can still be
   * messaged.
   */
  if ((await findPersonById(personId)) !== null) {
    await patchPersonConsent(personId, CONSENT_STATUS.UNKNOWN, new Date());
  }

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
