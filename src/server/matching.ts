import { identityCandidates, splitE164, waIdToE164 } from '../domain/phone/normalise';
import { describeError, logger } from './logger';
import { METRIC, count } from './metrics';
import type { WhatsappAccountRecord } from './repositories/accounts';
import {
  createPersonFromWhatsApp,
  findPeopleByAdditionalPhone,
  findPeopleByPrimaryPhone,
  type PersonRecord,
} from './repositories/people';

/**
 * Contact matching (FR-CID-3, FR-CID-5).
 *
 * The governing principle is that an *ambiguous* match is never guessed. Two
 * people sharing a number is rare; attaching a customer's WhatsApp history to
 * the wrong record is unrecoverable, because the conversation is then filed
 * under someone else's name and nobody knows to look. So the thread goes to
 * `NEEDS_REVIEW` with its candidates recorded, and a human decides.
 *
 * Review blocks *attribution*, never *ingestion*: messages keep arriving into
 * the thread while it waits.
 */

export type LinkCandidate = {
  personId: string;
  name: string;
  phone: string | null;
};

export type MatchResult =
  | { kind: 'matched'; person: PersonRecord }
  | { kind: 'created'; person: PersonRecord }
  | { kind: 'ambiguous'; candidates: LinkCandidate[] }
  | { kind: 'unmatched'; reason: 'auto_creation_disabled' | 'invalid_phone' };

const displayName = (person: PersonRecord): string =>
  [person.name?.firstName, person.name?.lastName].filter(Boolean).join(' ').trim() ||
  'Sem nome';

const primaryPhoneOf = (person: PersonRecord): string | null => {
  const number = person.phones?.primaryPhoneNumber;
  if (typeof number !== 'string' || number.length === 0) return null;

  return `${person.phones?.primaryPhoneCallingCode ?? ''}${number}`;
};

export const toLinkCandidates = (people: PersonRecord[]): LinkCandidate[] =>
  people.map((person) => ({
    personId: person.id,
    name: displayName(person),
    phone: primaryPhoneOf(person),
  }));

/**
 * Best-effort split of a WhatsApp profile name.
 *
 * The whole string becomes the first name when there is no space, because a
 * mononym in `lastName` reads as a missing first name everywhere in the CRM.
 * "Ana Maria Silva" gives `Ana` / `Maria Silva` — Portuguese surnames are
 * routinely compound, and splitting on the *last* space would file her under
 * "Silva" alone.
 */
export const splitProfileName = (
  profileName: string | null | undefined,
  fallback: string,
): { firstName: string; lastName: string } => {
  const trimmed = (profileName ?? '').trim().replace(/\s+/g, ' ');

  if (trimmed.length === 0) return { firstName: fallback, lastName: '' };

  const separator = trimmed.indexOf(' ');

  return separator === -1
    ? { firstName: trimmed, lastName: '' }
    : {
        firstName: trimmed.slice(0, separator),
        lastName: trimmed.slice(separator + 1),
      };
};

export const matchPerson = async ({
  waId,
  account,
  profileName,
}: {
  waId: string;
  account: WhatsappAccountRecord;
  profileName?: string | null;
}): Promise<MatchResult> => {
  const e164 = waIdToE164(waId);

  if (e164 === null) {
    logger.warn('matching.invalid_wa_id', { accountId: account.id });

    return { kind: 'unmatched', reason: 'invalid_phone' };
  }

  /**
   * Every variant is generated *before* declaring a number unknown. Brazil,
   * Argentina and Mexico all present a `wa_id` that differs from the stored
   * E.164, so a single-form lookup would auto-create a duplicate person for a
   * contact the CRM already has (FR-CID-2).
   */
  const candidates = identityCandidates(e164);

  const primaryMatches = await findPeopleByPrimaryPhone(candidates);

  const people =
    primaryMatches.length > 0
      ? primaryMatches
      : await findPeopleByAdditionalPhone(candidates);

  if (people.length === 1) return { kind: 'matched', person: people[0]! };

  if (people.length > 1) {
    count(METRIC.INBOUND_NEEDS_REVIEW);
    logger.info('matching.ambiguous', { accountId: account.id, candidateCount: people.length });

    return { kind: 'ambiguous', candidates: toLinkCandidates(people) };
  }

  // Per-account, so a test number cannot pollute the CRM (FR-ACC-5).
  if (account.contactAutoCreationEnabled === false) {
    return { kind: 'unmatched', reason: 'auto_creation_disabled' };
  }

  const parts = splitE164(e164);
  if (parts === null) return { kind: 'unmatched', reason: 'invalid_phone' };

  try {
    const person = await createPersonFromWhatsApp({
      ...splitProfileName(profileName, e164),
      nationalNumber: parts.nationalNumber,
      callingCode: parts.callingCode,
      countryCode: parts.countryCode.length === 0 ? null : parts.countryCode,
    });

    count(METRIC.INBOUND_AUTO_CREATED_PERSON);

    return { kind: 'created', person };
  } catch (error) {
    /**
     * Auto-creation failing must not lose the message. The thread simply stays
     * unlinked and a later inbound — or a human — resolves it.
     */
    logger.warn('matching.create_failed', { accountId: account.id, ...describeError(error) });

    return { kind: 'unmatched', reason: 'auto_creation_disabled' };
  }
};
