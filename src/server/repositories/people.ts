import type { ConsentStatus } from '../../domain/constants';
import { splitE164 } from '../../domain/phone/normalise';
import { nodesOf, query } from './base';

/**
 * Person reads and the auto-creation write (FR-CID-3).
 *
 * Person is a standard Twenty object we extend, so this repository is
 * deliberately narrow: it searches by phone, creates from a WhatsApp profile,
 * and writes the two consent columns. Anything else about a Person belongs to
 * the CRM, not to us.
 */

const PERSON_FIELDS = {
  id: true,
  name: { firstName: true, lastName: true },
  jobTitle: true,
  city: true,
  emails: { primaryEmail: true },
  phones: {
    primaryPhoneNumber: true,
    primaryPhoneCallingCode: true,
    primaryPhoneCountryCode: true,
    additionalPhones: true,
  },
  linkedinLink: { primaryLinkUrl: true },
  whatsappOptInStatus: true,
  whatsappOptInUpdatedAt: true,
  companyId: true,
} as const;

export type PersonRecord = {
  id: string;
  name?: { firstName?: string | null; lastName?: string | null } | null;
  jobTitle?: string | null;
  city?: string | null;
  emails?: { primaryEmail?: string | null } | null;
  phones?: {
    primaryPhoneNumber?: string | null;
    primaryPhoneCallingCode?: string | null;
    primaryPhoneCountryCode?: string | null;
    additionalPhones?: unknown;
  } | null;
  linkedinLink?: { primaryLinkUrl?: string | null } | null;
  whatsappOptInStatus?: string | null;
  whatsappOptInUpdatedAt?: string | null;
  companyId?: string | null;
};

/**
 * The indexed pass: primary phone, national number and calling code together.
 *
 * Matching on the national number alone would link `+244 923 000 000` to
 * `+351 923 000 000` — different people in different countries who happen to
 * share nine digits.
 */
export const findPeopleByPrimaryPhone = async (
  candidates: string[],
): Promise<PersonRecord[]> => {
  const split = candidates
    .map((candidate) => splitE164(candidate))
    .filter((parts) => parts !== null);

  if (split.length === 0) return [];

  const result = await query(
    (client) =>
      client.query({
        people: {
          __args: {
            filter: {
              or: split.map((parts) => ({
                phones: {
                  primaryPhoneNumber: { eq: parts.nationalNumber },
                  primaryPhoneCallingCode: { eq: parts.callingCode },
                },
              })),
            },
            first: 20,
          },
          edges: { node: PERSON_FIELDS },
        },
      }),
    'people.findByPrimaryPhone',
  );

  return nodesOf<PersonRecord>(result.people);
};

/**
 * The unindexed fallback over `additionalPhones` (probe P-5).
 *
 * `additionalPhones` is RAW_JSON and the schema exposes only a `like` filter on
 * it, so this is a substring scan over serialised JSON — correct but not
 * cheap, which is why it runs only when the indexed pass found nothing. The
 * national number is matched without its calling code because the stored
 * formatting of an additional phone is not normalised; results are re-checked
 * against the full candidate set by the caller.
 */
export const findPeopleByAdditionalPhone = async (
  candidates: string[],
): Promise<PersonRecord[]> => {
  const nationalNumbers = [
    ...new Set(
      candidates
        .map((candidate) => splitE164(candidate)?.nationalNumber)
        .filter((value): value is string => typeof value === 'string' && value.length >= 6),
    ),
  ];

  if (nationalNumbers.length === 0) return [];

  const result = await query(
    (client) =>
      client.query({
        people: {
          __args: {
            filter: {
              or: nationalNumbers.map((number) => ({
                phones: { additionalPhones: { like: `%${number}%` } },
              })),
            },
            first: 20,
          },
          edges: { node: PERSON_FIELDS },
        },
      }),
    'people.findByAdditionalPhone',
  );

  return nodesOf<PersonRecord>(result.people);
};

export const findPersonById = async (id: string): Promise<PersonRecord | null> => {
  const result = await query(
    (client) => client.query({ person: { __args: { filter: { id: { eq: id } } }, ...PERSON_FIELDS } }),
    'people.findById',
  );

  return (result.person as PersonRecord | null) ?? null;
};

export type PersonCreateInput = {
  firstName: string;
  lastName: string;
  nationalNumber: string;
  callingCode: string;
  countryCode: string | null;
};

/**
 * A person created from an inbound message is **`UNKNOWN`**, never `OPTED_IN`.
 *
 * Someone messaging support has not consented to marketing (FR-CAM-5, R-11).
 * Treating inbound contact as consent is the fastest route to a RED quality
 * rating and a suspended number, so the value is hard-coded here rather than
 * passed in — there is no caller that should be able to choose otherwise.
 */
export const createPersonFromWhatsApp = async (
  input: PersonCreateInput,
): Promise<PersonRecord> => {
  const result = await query(
    (client) =>
      client.mutation({
        createPerson: {
          __args: {
            data: {
              name: { firstName: input.firstName, lastName: input.lastName },
              phones: {
                primaryPhoneNumber: input.nationalNumber,
                primaryPhoneCallingCode: input.callingCode,
                ...(input.countryCode === null
                  ? {}
                  : { primaryPhoneCountryCode: input.countryCode }),
              },
              whatsappOptInStatus: 'UNKNOWN',
              createdBy: { source: 'MANUAL', name: 'WhatsApp' },
            },
          },
          ...PERSON_FIELDS,
        },
      }),
    'people.create',
  );

  return result.createPerson as PersonRecord;
};

export const patchPersonConsent = async (
  id: string,
  status: ConsentStatus,
  updatedAt: Date,
): Promise<void> => {
  await query(
    (client) =>
      client.mutation({
        updatePerson: {
          __args: {
            id,
            data: {
              whatsappOptInStatus: status,
              whatsappOptInUpdatedAt: updatedAt.toISOString(),
            },
          },
          id: true,
        },
      }),
    'people.patchConsent',
  );
};
