import {
  CONSENT_STATUS,
  type ConsentMethod,
  type ConsentStatus,
} from '../domain/constants';
import { logger } from './logger';
import { createConsentEvent } from './repositories/consent-events';
import { findPersonById, patchPersonConsent } from './repositories/people';
import { TIMELINE_EVENT, writeTimelineActivity } from './timeline';

/**
 * The single writer of consent state (FR-CON-1).
 *
 * The model is two-part by design: `person.whatsappOptInStatus` is the
 * denormalised current state so views, filters and the campaign audience query
 * can be indexed, and `whatsappConsentEvent` is the append-only evidence trail.
 * They are written here, together, in that order — a status with no event is a
 * consent decision with no proof, and proof is the entire point (SEC-11).
 *
 * The event goes first on purpose. If the second write fails we are left with
 * evidence of a change that did not take effect, which is recoverable and
 * visible; the reverse leaves an unexplained status nobody can audit.
 */

export type SetConsentInput = {
  personId: string;
  newStatus: Exclude<ConsentStatus, 'UNKNOWN'>;
  method: ConsentMethod;
  actorId?: string | null;
  wordingShown?: string | null;
  sourceReference?: string | null;
  notes?: string | null;
  occurredAt?: Date;
};

export type SetConsentResult = {
  changed: boolean;
  previousStatus: ConsentStatus;
};

const asConsentStatus = (value: unknown): ConsentStatus =>
  value === CONSENT_STATUS.OPTED_IN || value === CONSENT_STATUS.OPTED_OUT
    ? value
    : CONSENT_STATUS.UNKNOWN;

/**
 * Idempotent: re-stating the current status writes nothing and returns
 * `changed: false`.
 *
 * That is what makes "exactly one confirmation" true for a contact who sends
 * STOP three times (FR-CON-3) — the keyword handler sends its reply only when
 * something actually changed, so the suppression lives in one place instead of
 * in every caller.
 */
export const setConsent = async ({
  personId,
  newStatus,
  method,
  actorId = null,
  wordingShown = null,
  sourceReference = null,
  notes = null,
  occurredAt = new Date(),
}: SetConsentInput): Promise<SetConsentResult> => {
  const person = await findPersonById(personId);
  const previousStatus = asConsentStatus(person?.whatsappOptInStatus);

  if (previousStatus === newStatus) return { changed: false, previousStatus };

  await createConsentEvent({
    personId,
    newStatus,
    previousStatus,
    method,
    wordingShown,
    sourceReference,
    notes,
    actorId,
    occurredAt,
  });

  await patchPersonConsent(personId, newStatus, occurredAt);

  await writeTimelineActivity({
    name:
      newStatus === CONSENT_STATUS.OPTED_IN
        ? TIMELINE_EVENT.CONSENT_OPTED_IN
        : TIMELINE_EVENT.CONSENT_OPTED_OUT,
    happensAt: occurredAt,
    properties: { method, actorId, wordingShown },
    targetPersonId: personId,
    targetCompanyId: person?.companyId ?? null,
  });

  logger.info('consent.changed', {
    correlationId: sourceReference,
    personId,
    from: previousStatus,
    to: newStatus,
    method,
  });

  return { changed: true, previousStatus };
};
