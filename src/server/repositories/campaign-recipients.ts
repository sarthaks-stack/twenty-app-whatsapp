import {
  RECIPIENT_STATUS,
  type ExclusionReason,
  type RecipientStatus,
} from '../../domain/constants';
import { inBatches, isUniqueViolation } from '../batching';
import { nodesOf, query, type JsonObject } from './base';

/**
 * `whatsappCampaignRecipient` — the snapshot row and the unit of idempotency
 * (AR-20, FR-CAM-9).
 *
 * Ingestion touches this only to mirror a delivery status back from the
 * message, and to mark a recipient `RESPONDED` when they reply (FR-CAM-13).
 * The snapshot writes the rows; the runner claims them.
 *
 * **The claim is one mutation, not two.** Selecting ids and then updating them
 * would let two runner ticks select the same rows and both believe they own
 * them. Instead the update carries `status: PENDING` in its own filter and
 * returns the rows it actually changed, so a tick that lost the race is handed
 * an empty array rather than a duplicate send (AR-20 guarantee 1).
 */

const RECIPIENT_FIELDS = {
  id: true,
  status: true,
  exclusionReason: true,
  resolvedParameters: true,
  resolvedPhone: true,
  errorCode: true,
  errorDetail: true,
  claimedAt: true,
  campaignId: true,
  personId: true,
  threadId: true,
  messageId: true,
} as const;

export type WhatsappCampaignRecipientRecord = {
  id: string;
  status?: string | null;
  exclusionReason?: string | null;
  resolvedParameters?: JsonObject | null;
  resolvedPhone?: string | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  claimedAt?: string | null;
  campaignId?: string | null;
  personId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
};

export const findRecipientByMessageId = async (
  messageId: string,
): Promise<WhatsappCampaignRecipientRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: { filter: { messageId: { eq: messageId } }, first: 1 },
          edges: { node: RECIPIENT_FIELDS },
        },
      }),
    'recipients.findByMessageId',
  );

  return nodesOf<WhatsappCampaignRecipientRecord>(result.whatsappCampaignRecipients)[0] ?? null;
};

export const findRecipientsByMessageIds = async (
  messageIds: string[],
): Promise<Map<string, WhatsappCampaignRecipientRecord>> => {
  if (messageIds.length === 0) return new Map();

  const result = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: { filter: { messageId: { in: messageIds } }, first: messageIds.length },
          edges: { node: RECIPIENT_FIELDS },
        },
      }),
    'recipients.findByMessageIds',
  );

  return new Map(
    nodesOf<WhatsappCampaignRecipientRecord>(result.whatsappCampaignRecipients)
      .filter((recipient) => typeof recipient.messageId === 'string')
      .map((recipient) => [recipient.messageId!, recipient]),
  );
};

export const findRecipientByThreadId = async (
  campaignId: string,
  threadId: string,
): Promise<WhatsappCampaignRecipientRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: {
            filter: { campaignId: { eq: campaignId }, threadId: { eq: threadId } },
            first: 1,
          },
          edges: { node: RECIPIENT_FIELDS },
        },
      }),
    'recipients.findByThreadId',
  );

  return nodesOf<WhatsappCampaignRecipientRecord>(result.whatsappCampaignRecipients)[0] ?? null;
};

/**
 * Recipients claimed by a runner tick that never sent them (specs/07 §6.1).
 *
 * A claim is a lease, not a lock: the runner that took it may have died
 * mid-tick. Without this sweep those rows would sit `CLAIMED` forever and the
 * campaign would report itself running while sending nothing — the failure mode
 * that looks most like success.
 */
export const findStaleClaimedRecipients = async (
  claimedBefore: Date,
  limit = 60,
): Promise<WhatsappCampaignRecipientRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: {
            filter: {
              status: { eq: 'CLAIMED' },
              claimedAt: { lt: claimedBefore.toISOString() },
            },
            first: limit,
          },
          edges: { node: RECIPIENT_FIELDS },
        },
      }),
    'recipients.findStaleClaims',
  );

  return nodesOf<WhatsappCampaignRecipientRecord>(result.whatsappCampaignRecipients);
};

export type RecipientCreateInput = {
  campaignId: string;
  personId: string;
  status: RecipientStatus;
  exclusionReason?: ExclusionReason | null;
  resolvedPhone?: string | null;
  resolvedParameters?: Record<string, unknown> | null;
};

const findRecipientByPerson = async (
  campaignId: string,
  personId: string,
): Promise<WhatsappCampaignRecipientRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: {
            filter: { campaignId: { eq: campaignId }, personId: { eq: personId } },
            first: 1,
          },
          edges: { node: RECIPIENT_FIELDS },
        },
      }),
    'recipients.findByPerson',
  );

  return nodesOf<WhatsappCampaignRecipientRecord>(result.whatsappCampaignRecipients)[0] ?? null;
};

/**
 * Writes a page of snapshot rows, chunked at 60 (NFR-S4).
 *
 * The fast path is one bulk create per 60 rows. The interesting path is what
 * happens when the unique `(campaign, person)` index refuses one: Twenty
 * reports the collision for the *whole batch*, so the batch is retried row by
 * row, and a row that still collides is **updated in place** rather than
 * skipped.
 *
 * Updating rather than skipping is what makes a rebuild mean something. The
 * motivating case is exactly the one FR-CAM-3 describes: a campaign excludes
 * 412 people for `no_consent`, a consent campaign wins some of them over, and
 * the admin rebuilds. If the existing rows were merely skipped, those people
 * would keep their stale exclusion and the rebuild would change nothing —
 * quietly, which is the worst way for it to be wrong.
 *
 * It also makes the resume path idempotent without depending on how Twenty
 * treats a soft-deleted row's unique index (probe P-4, still unanswered):
 * whether the old row is visible or not, the outcome is one correct row.
 */
export const upsertRecipients = async (
  rows: RecipientCreateInput[],
): Promise<{ created: number; updated: number }> => {
  if (rows.length === 0) return { created: 0, updated: 0 };

  let created = 0;
  let updated = 0;

  await inBatches(
    rows,
    async (batch) => {
      try {
        const result = await query(
          (client) =>
            client.mutation({
              createWhatsappCampaignRecipients: { __args: { data: batch }, id: true },
            }),
          'recipients.createMany',
        );

        created += (result.createWhatsappCampaignRecipients ?? []).length;

        return;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }

      for (const row of batch) {
        try {
          await query(
            (client) =>
              client.mutation({
                createWhatsappCampaignRecipient: { __args: { data: row }, id: true },
              }),
            'recipients.createOne',
          );

          created += 1;
        } catch (rowError) {
          if (!isUniqueViolation(rowError)) throw rowError;

          const existing = await findRecipientByPerson(row.campaignId, row.personId);

          /**
           * A collision with a row we cannot then find means the index is
           * holding a *soft-deleted* row. Re-resolving it is impossible and
           * silently dropping the person would shrink the audience without
           * saying so, so the failure is raised.
           */
          if (existing === null) throw rowError;

          await patchRecipient(existing.id, {
            status: row.status,
            exclusionReason: row.exclusionReason ?? null,
            resolvedPhone: row.resolvedPhone ?? null,
            resolvedParameters: row.resolvedParameters ?? null,
            errorCode: null,
            errorDetail: null,
            claimedAt: null,
          });

          updated += 1;
        }
      }
    },
    { label: 'recipients.upsertMany' },
  );

  return { created, updated };
};

/** What a retired row's `errorCode` says, so a rebuild is legible in the data. */
export const REBUILT_ERROR_CODE = 'SNAPSHOT_REBUILT';

/**
 * Retires the rows of a previous snapshot before a rebuild.
 *
 * A campaign can be built more than once — an admin fixes a mapping, changes
 * the template, widens the view — and the second build must not inherit the
 * first one's rows. It cannot delete them either: hard deletes live in the
 * erasure routine alone, and a recipient row is the audit trail of who a
 * campaign was going to message.
 *
 * So they are retired instead: `SKIPPED`, with a code that says why. The
 * duplicate detector ignores retired rows, and `upsertRecipients` writes over
 * any of them whose person is still in the audience — so a rebuilt campaign
 * keeps one row per person, showing the current snapshot's decision.
 */
export const retirePreviousSnapshot = async (campaignId: string): Promise<number> => {
  let total = 0;

  /**
   * Looped because the server may cap how many rows one filtered update
   * touches. Bounded because "keep going until it says zero" is a promise the
   * caller cannot keep if something else is writing rows at the same time.
   */
  for (let pass = 0; pass < 200; pass += 1) {
    const updated = await query(
      (client) =>
        client.mutation({
          updateWhatsappCampaignRecipients: {
            __args: {
              data: {
                status: RECIPIENT_STATUS.SKIPPED,
                errorCode: REBUILT_ERROR_CODE,
                errorDetail: 'Superseded by a later build of this campaign',
                claimedAt: null,
              },
              filter: {
                campaignId: { eq: campaignId },
                status: {
                  in: [
                    RECIPIENT_STATUS.PENDING,
                    RECIPIENT_STATUS.CLAIMED,
                    RECIPIENT_STATUS.EXCLUDED,
                  ],
                },
              },
            },
            id: true,
          },
        }),
      'recipients.retireSnapshot',
    );

    const count = (updated.updateWhatsappCampaignRecipients ?? []).length;

    total += count;

    if (count === 0) break;
  }

  return total;
};

/**
 * Which of these numbers this campaign has already accepted (FR-CAM-3).
 *
 * The duplicate detector, and deliberately **not** the `kv` set the spec
 * sketched. A set in `kv` has to hold every accepted number for the life of
 * the snapshot, which at 100 000 recipients is a megabyte re-read and
 * re-written on every page, with no compare-and-swap to make the read-modify-
 * write safe. The rows already exist and already carry `resolvedPhone`, so
 * asking them is exact, needs no cleanup, and survives a resume that a lost
 * `kv` write would not.
 */
export const findExistingPhones = async (
  campaignId: string,
  phones: string[],
): Promise<Set<string>> => {
  if (phones.length === 0) return new Set();

  const found = new Set<string>();

  await inBatches(
    phones,
    async (batch) => {
      const result = await query(
        (client) =>
          client.query({
            whatsappCampaignRecipients: {
              __args: {
                filter: {
                  campaignId: { eq: campaignId },
                  resolvedPhone: { in: batch },
                  /**
                   * Only *accepted* rows occupy a number. An excluded row
                   * keeps its `resolvedPhone` for the audit trail, and
                   * counting it here would report the next person on that
                   * number as a duplicate of someone we never messaged —
                   * hiding the real reason behind a misleading one.
                   */
                  exclusionReason: { is: 'NULL' },
                  /**
                   * Nor does a row from a *superseded* snapshot. A rebuild
                   * retires the previous rows to `SKIPPED`, and without this
                   * line every one of them would answer "taken" for its own
                   * number — turning the second build of a campaign into an
                   * audience where everybody is a duplicate of themselves.
                   */
                  status: { neq: RECIPIENT_STATUS.SKIPPED },
                },
                first: batch.length,
              },
              edges: { node: { resolvedPhone: true } },
            },
          }),
        'recipients.findExistingPhones',
      );

      for (const row of nodesOf<{ resolvedPhone?: string | null }>(
        result.whatsappCampaignRecipients,
      )) {
        if (typeof row.resolvedPhone === 'string') found.add(row.resolvedPhone);
      }
    },
    { size: 200, label: 'recipients.findExistingPhones' },
  );

  return found;
};

/**
 * Takes ownership of up to `limit` pending recipients (specs/07 §6 step g).
 *
 * Two statements, but the second is the one that decides: its filter still
 * requires `PENDING`, so the rows it returns are the rows this tick won. A
 * concurrent tick that selected the same ids gets nothing back and sends
 * nothing — which is why the caller must use the returned rows and never the
 * ids it asked for.
 */
export const claimPendingRecipients = async (
  campaignId: string,
  limit: number,
  now: Date,
): Promise<WhatsappCampaignRecipientRecord[]> => {
  if (limit <= 0) return [];

  const candidates = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: {
            filter: { campaignId: { eq: campaignId }, status: { eq: 'PENDING' } },
            orderBy: [{ createdAt: 'AscNullsFirst' }],
            first: Math.min(limit, 60),
          },
          edges: { node: { id: true } },
        },
      }),
    'recipients.selectPending',
  );

  const ids = nodesOf<{ id: string }>(candidates.whatsappCampaignRecipients).map(
    (node) => node.id,
  );

  if (ids.length === 0) return [];

  const claimed = await query(
    (client) =>
      client.mutation({
        updateWhatsappCampaignRecipients: {
          __args: {
            data: { status: 'CLAIMED', claimedAt: now.toISOString() },
            filter: { id: { in: ids }, status: { eq: 'PENDING' } },
          },
          ...RECIPIENT_FIELDS,
        },
      }),
    'recipients.claim',
  );

  return (claimed.updateWhatsappCampaignRecipients ??
    []) as unknown as WhatsappCampaignRecipientRecord[];
};

/**
 * How many recipients a campaign has in a given state.
 *
 * Read from the records rather than from a counter, because the counters are
 * `kv`-derived and approximate by construction — and "are there any pending
 * left?" decides whether a campaign is finished, which is not a question to
 * answer approximately.
 */
export const countRecipients = async (
  campaignId: string,
  statuses: RecipientStatus[],
): Promise<number> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: {
            filter: {
              campaignId: { eq: campaignId },
              ...(statuses.length === 0 ? {} : { status: { in: statuses } }),
            },
            first: 1,
          },
          totalCount: true,
        },
      }),
    'recipients.count',
  );

  return result.whatsappCampaignRecipients?.totalCount ?? 0;
};

/**
 * The most recent terminal outcomes, newest first — the circuit breaker's
 * window (specs/07 §8, AR-22).
 *
 * Read from the rows rather than kept as a running counter, so pausing and
 * resuming a campaign does not reset the safety net. Recency is measured by
 * `updatedAt` because a recipient reaches its terminal state by being written
 * to; that is a proxy, but the alternative — a dedicated timestamp per
 * outcome — would add a column to say what the row's own history already says.
 */
export const listRecentTerminalRecipients = async (
  campaignId: string,
  limit: number,
): Promise<WhatsappCampaignRecipientRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: {
            filter: {
              campaignId: { eq: campaignId },
              status: { in: ['SENT', 'DELIVERED', 'READ', 'RESPONDED', 'FAILED', 'SKIPPED'] },
            },
            orderBy: [{ updatedAt: 'DescNullsLast' }],
            // A *read* has no 60-record ceiling — that limit is for mutations.
            // Capping here would silently shrink the configured failure window.
            first: Math.min(limit, 500),
          },
          edges: { node: { id: true, status: true } },
        },
      }),
    'recipients.recentTerminal',
  );

  return nodesOf<WhatsappCampaignRecipientRecord>(result.whatsappCampaignRecipients);
};

/** A sample of rows for the pre-flight breakdown and the campaign detail view. */
export const listRecipients = async ({
  campaignId,
  statuses = [],
  exclusionReason,
  limit = 10,
}: {
  campaignId: string;
  statuses?: RecipientStatus[];
  exclusionReason?: ExclusionReason;
  limit?: number;
}): Promise<WhatsappCampaignRecipientRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaignRecipients: {
          __args: {
            filter: {
              campaignId: { eq: campaignId },
              ...(statuses.length === 0 ? {} : { status: { in: statuses } }),
              ...(exclusionReason === undefined
                ? {}
                : { exclusionReason: { eq: exclusionReason } }),
            },
            orderBy: [{ createdAt: 'AscNullsFirst' }],
            first: Math.min(limit, 60),
          },
          edges: { node: RECIPIENT_FIELDS },
        },
      }),
    'recipients.list',
  );

  return nodesOf<WhatsappCampaignRecipientRecord>(result.whatsappCampaignRecipients);
};

export type RecipientPatch = {
  status?: RecipientStatus;
  exclusionReason?: ExclusionReason | null;
  resolvedPhone?: string | null;
  resolvedParameters?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  claimedAt?: string | null;
  threadId?: string | null;
  messageId?: string | null;
};

export const patchRecipient = async (id: string, data: RecipientPatch): Promise<void> => {
  await query(
    (client) =>
      client.mutation({ updateWhatsappCampaignRecipient: { __args: { id, data }, id: true } }),
    'recipients.patch',
  );
};

/**
 * Applies one patch to many recipients, chunked at 60.
 *
 * A status webhook carrying 50 recipient transitions would otherwise cost 50
 * mutations — the whole per-minute budget for one Meta delivery (NFR-R2, 03
 * §5.2). Recipients sharing a target status are grouped by the caller.
 */
export const patchRecipients = async (
  ids: string[],
  data: RecipientPatch,
): Promise<void> => {
  if (ids.length === 0) return;

  await inBatches(
    ids,
    (batch) =>
      query(
        (client) =>
          client.mutation({
            updateWhatsappCampaignRecipients: {
              __args: { data, filter: { id: { in: batch } } },
              id: true,
            },
          }),
        'recipients.patchMany',
      ),
    { label: 'recipients.patchMany' },
  );
};
