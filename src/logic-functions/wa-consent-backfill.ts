import { defineLogicFunction } from 'twenty-sdk/define';
import type { DatabaseEventPayload, ObjectRecordUpdateEvent } from 'twenty-sdk/define';

import { LF_CONSENT_BACKFILL } from '../constants/universal-identifiers';
import {
  CONSENT_METHOD,
  CONSENT_STATUS,
  type ConsentStatus,
} from '../domain/constants';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import {
  createConsentEvent,
  listConsentEvents,
} from '../server/repositories/consent-events';
import { TIMELINE_EVENT, writeTimelineActivity } from '../server/timeline';

/**
 * Editing consent on the Person record, without escaping the evidence trail
 * (specs/06 §11).
 *
 * `whatsappOptInStatus` is an ordinary field on Person, so an admin can change
 * it inline — and should be able to, because that is where someone looks when
 * a customer says "stop emailing me about this" on the phone. But the field
 * alone is a claim with no provenance, and provenance is the whole reason
 * `whatsappConsentEvent` exists (SEC-11).
 *
 * So rather than locking the field, a database-event function watches it and
 * back-fills the event that the direct edit skipped, attributing it to the
 * member who made the change. Direct edits are thus permitted *and* audited,
 * which is a better outcome than a read-only field people work around by
 * asking someone with API access.
 *
 * **This must not fight `setConsent`.** That function writes the event first
 * and the field second, so by the time this trigger sees the update an event
 * already exists — and writing a second one would double every keyword opt-out
 * in the trail. The guard is a recent matching event, checked below.
 */

type PersonShape = {
  id?: string;
  whatsappOptInStatus?: string | null;
};

export type ConsentBackfillPayload = DatabaseEventPayload<
  ObjectRecordUpdateEvent<PersonShape>
>;

export type BackfillResult = {
  outcome: 'recorded' | 'skipped';
  reason?: string;
};

/**
 * How recently `setConsent` must have written for this update to be its doing.
 *
 * Generous on purpose. A false skip loses one back-filled event for an edit
 * that a human made within seconds of an automated one — rare, and the field
 * change is still visible in Twenty's own audit log. A false *write* duplicates
 * consent evidence, which is the thing an auditor reads.
 */
export const OWN_WRITE_WINDOW_MS = 30_000;

const asConsentStatus = (value: unknown): ConsentStatus =>
  value === CONSENT_STATUS.OPTED_IN || value === CONSENT_STATUS.OPTED_OUT
    ? value
    : CONSENT_STATUS.UNKNOWN;

/**
 * Whether an event already covers this change.
 *
 * Matching is on the resulting status and recency rather than on an id, because
 * the trigger has no handle on the write that caused it — the platform gives us
 * before and after, not a transaction.
 */
export const isAlreadyRecorded = ({
  events,
  newStatus,
  now,
  windowMs = OWN_WRITE_WINDOW_MS,
}: {
  events: { newStatus?: string | null; occurredAt?: string | null }[];
  newStatus: ConsentStatus;
  now: Date;
  windowMs?: number;
}): boolean =>
  events.some((event) => {
    if (event.newStatus !== newStatus) return false;
    if (typeof event.occurredAt !== 'string') return false;

    const occurredAt = new Date(event.occurredAt);

    if (Number.isNaN(occurredAt.getTime())) return false;

    return now.getTime() - occurredAt.getTime() < windowMs;
  });

export const backfillConsentEdit = async (
  payload: ConsentBackfillPayload,
): Promise<BackfillResult> => {
  const log = logger.child({ fn: 'wa-consent-backfill', correlationId: payload.recordId });

  const before = asConsentStatus(payload.properties?.before?.whatsappOptInStatus);
  const after = asConsentStatus(payload.properties?.after?.whatsappOptInStatus);

  if (before === after) return { outcome: 'skipped', reason: 'status unchanged' };

  const personId = payload.recordId;

  if (typeof personId !== 'string' || personId.length === 0) {
    return { outcome: 'skipped', reason: 'no record id' };
  }

  /**
   * A move *to* `UNKNOWN` is a clearing, not a consent decision, and the event
   * table has no status for it — deliberately, since erasing evidence is what
   * the erasure routine is for. It is logged so the change is not invisible.
   */
  if (after === CONSENT_STATUS.UNKNOWN) {
    log.warn('wa.consent.cleared_by_hand', { personId, from: before });

    return { outcome: 'skipped', reason: 'cleared to unknown' };
  }

  const now = new Date();

  try {
    const recent = await listConsentEvents(personId, 5);

    if (isAlreadyRecorded({ events: recent, newStatus: after, now })) {
      return { outcome: 'skipped', reason: 'already recorded by setConsent' };
    }
  } catch (error) {
    /**
     * If the check cannot run, write the event anyway. A duplicate is
     * confusing; a missing one is a compliance gap, and only one of those can
     * be reconstructed later.
     */
    log.warn('wa.consent.backfill_check_failed', describeError(error));
  }

  await createConsentEvent({
    personId,
    newStatus: after,
    previousStatus: before,
    method: CONSENT_METHOD.MANUAL,
    actorId: payload.workspaceMemberId ?? null,
    wordingShown: null,
    notes: 'Recorded from a direct edit of the Person record',
    occurredAt: now,
  });

  await writeTimelineActivity({
    name:
      after === CONSENT_STATUS.OPTED_IN
        ? TIMELINE_EVENT.CONSENT_OPTED_IN
        : TIMELINE_EVENT.CONSENT_OPTED_OUT,
    happensAt: now,
    properties: { method: CONSENT_METHOD.MANUAL, actorId: payload.workspaceMemberId ?? null },
    targetPersonId: personId,
  });

  count(METRIC.CONSENT_BACKFILLED);
  log.info('wa.consent.backfilled', { personId, from: before, to: after });

  return { outcome: 'recorded' };
};

export const handler = async (
  payload: ConsentBackfillPayload,
): Promise<BackfillResult> => {
  try {
    return await backfillConsentEdit(payload);
  } catch (error) {
    /**
     * Swallowed. This runs on someone else's write: throwing would surface as a
     * failed edit in the UI for a field that did change, which is both confusing
     * and untrue.
     */
    logger.error('wa.consent.backfill_failed', describeError(error));

    return { outcome: 'skipped', reason: 'error' };
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_CONSENT_BACKFILL,
  name: 'wa-consent-backfill',
  description:
    'Records a consent event when whatsappOptInStatus is edited directly on a Person.',
  timeoutSeconds: 30,
  databaseEventTriggerSettings: {
    eventName: 'person.updated',
    updatedFields: ['whatsappOptInStatus'],
  },
  handler,
});
