import type { ConsentMethod, ConsentStatus } from '../../domain/constants';
import { nodesOf, query } from './base';

/**
 * `whatsappConsentEvent` — append-only evidence (FR-CON-1, SEC-11).
 *
 * There is no update and no delete here, deliberately. The denormalised
 * `person.whatsappOptInStatus` exists so views and the campaign audience query
 * can be indexed; *this* table is what an Angolan Lei 22/11 or GDPR enquiry
 * actually needs — who, when, how, and what wording was shown. A SELECT field
 * alone would not survive scrutiny.
 */

const CONSENT_FIELDS = {
  id: true,
  isTombstone: true,
  newStatus: true,
  previousStatus: true,
  method: true,
  wordingShown: true,
  sourceReference: true,
  occurredAt: true,
  notes: true,
  personId: true,
  actorId: true,
} as const;

export type WhatsappConsentEventRecord = {
  id: string;
  isTombstone?: boolean | null;
  newStatus?: string | null;
  previousStatus?: string | null;
  method?: string | null;
  wordingShown?: string | null;
  sourceReference?: string | null;
  occurredAt?: string | null;
  notes?: string | null;
  personId?: string | null;
  actorId?: string | null;
};

export const createConsentEvent = async (input: {
  personId: string;
  /** Null only for an erasure tombstone, which records a removal, not a decision. */
  newStatus: Exclude<ConsentStatus, 'UNKNOWN'> | null;
  previousStatus: ConsentStatus | null;
  method: ConsentMethod;
  isTombstone?: boolean;
  wordingShown?: string | null;
  sourceReference?: string | null;
  notes?: string | null;
  actorId?: string | null;
  occurredAt: Date;
}): Promise<WhatsappConsentEventRecord> => {
  const result = await query(
    (client) =>
      client.mutation({
        createWhatsappConsentEvent: {
          __args: {
            data: {
              personId: input.personId,
              newStatus: input.newStatus,
              previousStatus: input.previousStatus,
              method: input.method,
              occurredAt: input.occurredAt.toISOString(),
              ...(input.isTombstone === true ? { isTombstone: true } : {}),
              ...(input.wordingShown === undefined ? {} : { wordingShown: input.wordingShown }),
              ...(input.sourceReference === undefined
                ? {}
                : { sourceReference: input.sourceReference }),
              ...(input.notes === undefined ? {} : { notes: input.notes }),
              ...(input.actorId === undefined || input.actorId === null
                ? {}
                : { actorId: input.actorId }),
            },
          },
          ...CONSENT_FIELDS,
        },
      }),
    'consentEvents.create',
  );

  return result.createWhatsappConsentEvent as WhatsappConsentEventRecord;
};

export const listConsentEvents = async (
  personId: string,
  limit = 20,
): Promise<WhatsappConsentEventRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappConsentEvents: {
          __args: {
            filter: { personId: { eq: personId } },
            orderBy: [{ occurredAt: 'DescNullsLast' }],
            first: limit,
          },
          edges: { node: CONSENT_FIELDS },
        },
      }),
    'consentEvents.list',
  );

  return nodesOf<WhatsappConsentEventRecord>(result.whatsappConsentEvents);
};
