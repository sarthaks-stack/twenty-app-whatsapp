import type {
  Direction,
  ThreadStatus,
  WindowKind,
  WindowState,
} from '../../domain/constants';
import { inBatches } from '../batching';
import { nodesOf, pageOf, query, type JsonObject } from './base';

/**
 * `whatsappThread` — one conversation per (account, waId) (FR-THR-1).
 *
 * `waId` stores Meta's exact string and `dialablePhone` our canonical E.164,
 * because for Argentina and Mexico they differ (FR-CID-2). Sends use `waId`;
 * display and dialling use `dialablePhone`.
 */

const THREAD_FIELDS = {
  id: true,
  waId: true,
  profileName: true,
  dialablePhone: true,
  status: true,
  lastInboundAt: true,
  lastOutboundAt: true,
  lastMessageAt: true,
  serviceWindowExpiresAt: true,
  windowState: true,
  windowKind: true,
  unreadCount: true,
  lastMessagePreview: true,
  lastMessageDirection: true,
  referral: true,
  linkCandidates: true,
  originCampaignId: true,
  isBlocked: true,
  accountId: true,
  personId: true,
  assigneeId: true,
} as const;

export type WhatsappThreadRecord = {
  id: string;
  waId?: string | null;
  profileName?: string | null;
  dialablePhone?: string | null;
  status?: string | null;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  lastMessageAt?: string | null;
  serviceWindowExpiresAt?: string | null;
  windowState?: string | null;
  windowKind?: string | null;
  unreadCount?: number | null;
  lastMessagePreview?: string | null;
  lastMessageDirection?: string | null;
  referral?: JsonObject | null;
  linkCandidates?: JsonObject | null;
  originCampaignId?: string | null;
  isBlocked?: boolean | null;
  accountId?: string | null;
  personId?: string | null;
  assigneeId?: string | null;
};

export const findThread = async (
  accountId: string,
  waId: string,
): Promise<WhatsappThreadRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappThreads: {
          __args: {
            filter: { accountId: { eq: accountId }, waId: { eq: waId } },
            first: 1,
          },
          edges: { node: THREAD_FIELDS },
        },
      }),
    'threads.find',
  );

  return nodesOf<WhatsappThreadRecord>(result.whatsappThreads)[0] ?? null;
};

/**
 * Which of these numbers a human has blocked (specs/07 §3.1 rule 5).
 *
 * One query per snapshot page rather than one per person: an audience of
 * 100 000 would otherwise spend its entire Core API budget asking whether each
 * contact is blocked, and the answer is nearly always no. Returned as a set
 * because the caller only needs membership.
 */
export const findBlockedWaIds = async (
  accountId: string,
  waIds: string[],
): Promise<Set<string>> => {
  if (waIds.length === 0) return new Set();

  const result = await query(
    (client) =>
      client.query({
        whatsappThreads: {
          __args: {
            filter: {
              accountId: { eq: accountId },
              waId: { in: waIds },
              isBlocked: { eq: true },
            },
            first: waIds.length,
          },
          edges: { node: { waId: true } },
        },
      }),
    'threads.findBlocked',
  );

  return new Set(
    nodesOf<{ waId?: string | null }>(result.whatsappThreads)
      .map((thread) => thread.waId)
      .filter((waId): waId is string => typeof waId === 'string'),
  );
};

export const findThreadById = async (id: string): Promise<WhatsappThreadRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappThreads: {
          __args: { filter: { id: { eq: id } }, first: 1 },
          edges: { node: THREAD_FIELDS },
        },
      }),
    'threads.findById',
  );

  return nodesOf<WhatsappThreadRecord>(result.whatsappThreads)[0] ?? null;
};

export type ThreadCreateInput = {
  accountId: string;
  waId: string;
  dialablePhone: string | null;
  profileName: string | null;
  personId?: string | null;
  assigneeId?: string | null;
  status?: ThreadStatus;
  windowState?: WindowState;
  windowKind?: WindowKind;
  originCampaignId?: string | null;
  linkCandidates?: JsonObject | null;
};

export const createThread = async (
  input: ThreadCreateInput,
): Promise<WhatsappThreadRecord> => {
  const result = await query(
    (client) =>
      client.mutation({
        createWhatsappThread: {
          __args: {
            data: {
              accountId: input.accountId,
              waId: input.waId,
              dialablePhone: input.dialablePhone,
              profileName: input.profileName,
              ...(input.personId === undefined ? {} : { personId: input.personId }),
              ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.windowState === undefined ? {} : { windowState: input.windowState }),
              ...(input.windowKind === undefined ? {} : { windowKind: input.windowKind }),
              ...(input.originCampaignId === undefined
                ? {}
                : { originCampaignId: input.originCampaignId }),
              ...(input.linkCandidates === undefined
                ? {}
                : { linkCandidates: input.linkCandidates }),
            },
          },
          ...THREAD_FIELDS,
        },
      }),
    'threads.create',
  );

  return result.createWhatsappThread as WhatsappThreadRecord;
};

export type ThreadPatch = {
  profileName?: string | null;
  dialablePhone?: string | null;
  status?: ThreadStatus;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastMessageAt?: string;
  serviceWindowExpiresAt?: string | null;
  windowState?: WindowState;
  windowKind?: WindowKind;
  unreadCount?: number;
  lastMessagePreview?: string | null;
  lastMessageDirection?: Direction;
  referral?: JsonObject | null;
  linkCandidates?: JsonObject | null;
  personId?: string | null;
  assigneeId?: string | null;
  originCampaignId?: string | null;
  isBlocked?: boolean;
  snoozedUntil?: string | null;
};

/**
 * One patch per inbound message, not one per field.
 *
 * The inbound processor changes seven thread columns at once — timestamps,
 * preview, unread count, window. Writing them separately would multiply the
 * Core API cost of every message by seven and open a window where the thread
 * shows a new preview with a stale expiry.
 */
export const patchThread = async (id: string, data: ThreadPatch): Promise<void> => {
  await query(
    (client) => client.mutation({ updateWhatsappThread: { __args: { id, data }, id: true } }),
    'threads.patch',
  );
};

/**
 * One patch applied to many threads, chunked at 60.
 *
 * The window sweeper's whole cost model depends on this: expiring 60 windows
 * as 60 mutations every quarter hour would be a standing load on the Core API
 * for what is only a cache refresh.
 */
export const patchThreads = async (ids: string[], data: ThreadPatch): Promise<void> => {
  if (ids.length === 0) return;

  await inBatches(
    ids,
    (batch) =>
      query(
        (client) =>
          client.mutation({
            updateWhatsappThreads: {
              __args: { data, filter: { id: { in: batch } } },
              id: true,
            },
          }),
        'threads.patchMany',
      ),
    { label: 'threads.patchMany' },
  );
};

/**
 * Conversations with no activity for a while — the optional auto-close sweep
 * (Q-3). Only `OPEN` and `AWAITING_REPLY` are candidates; a `NEEDS_REVIEW`
 * thread is waiting on a human and closing it would hide the request.
 */
export const findIdleThreads = async (
  idleSince: Date,
  limit = 60,
): Promise<WhatsappThreadRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappThreads: {
          __args: {
            filter: {
              status: { in: ['OPEN', 'AWAITING_REPLY'] },
              lastMessageAt: { lt: idleSince.toISOString() },
            },
            first: limit,
          },
          edges: { node: { id: true, status: true, lastMessageAt: true } },
        },
      }),
    'threads.findIdle',
  );

  return nodesOf<WhatsappThreadRecord>(result.whatsappThreads);
};

/**
 * The conversations of one Person, newest first (FR-UI-1, FR-UI-3).
 *
 * Plural because one contact can hold two conversations — a second number, or a
 * number that moved between accounts — and the Person tab has to show the one
 * that is actually live rather than whichever the database returned first.
 */
export const findThreadsForPerson = async (
  personId: string,
  limit = 10,
): Promise<WhatsappThreadRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappThreads: {
          __args: {
            filter: { personId: { eq: personId } },
            orderBy: [{ lastMessageAt: 'DescNullsLast' }],
            first: limit,
          },
          edges: { node: THREAD_FIELDS },
        },
      }),
    'threads.findForPerson',
  );

  return nodesOf<WhatsappThreadRecord>(result.whatsappThreads);
};

export type InboxFilterSpec =
  | { kind: 'mine'; assigneeId: string }
  | { kind: 'unassigned' }
  | { kind: 'all' }
  | { kind: 'campaign_replies' }
  | { kind: 'window_expiring'; now: Date; horizon: Date }
  | { kind: 'closed' };

export type ThreadPage = { threads: WhatsappThreadRecord[]; nextCursor: string | null };

/**
 * The inbox list (FR-UI-2).
 *
 * Every filter but `closed` excludes closed conversations, because that is what
 * closing one is *for* — `close` touches neither Meta nor the window, it exists
 * so a handled conversation leaves the list (specs/05). `closed` is the way
 * back; without it the state would be a one-way door.
 *
 * Ordered by `lastMessageAt` descending, which is also why the inbox has no
 * delta mode: a thread's position changes when *another* thread receives a
 * message, so an incremental list would show a stale order until something in
 * it happened to change. Fifty rows on each poll is the honest read.
 */
export const listInboxThreads = async (
  spec: InboxFilterSpec,
  { limit = 50, after = null }: { limit?: number; after?: string | null } = {},
): Promise<ThreadPage> => {
  const notClosed = { status: { neq: 'CLOSED' } } as const;

  /**
   * `as const` on every branch, not for style: without it each enum literal
   * widens to `string` and the generated filter input rejects the lot.
   */
  const filter =
    spec.kind === 'mine'
      ? ({ ...notClosed, assigneeId: { eq: spec.assigneeId } } as const)
      : spec.kind === 'unassigned'
        ? ({ ...notClosed, assigneeId: { is: 'NULL' } } as const)
        : spec.kind === 'campaign_replies'
          ? ({
              ...notClosed,
              originCampaignId: { is: 'NOT_NULL' },
              lastMessageDirection: { eq: 'INBOUND' },
            } as const)
          : spec.kind === 'window_expiring'
            ? ({
                ...notClosed,
                windowState: { eq: 'OPEN' },
                serviceWindowExpiresAt: {
                  gte: spec.now.toISOString(),
                  lte: spec.horizon.toISOString(),
                },
              } as const)
            : spec.kind === 'closed'
              ? ({ status: { eq: 'CLOSED' } } as const)
              : notClosed;

  const result = await query(
    (client) =>
      client.query({
        whatsappThreads: {
          __args: {
            filter,
            orderBy: [{ lastMessageAt: 'DescNullsLast' }],
            first: limit,
            ...(after === null ? {} : { after }),
          },
          edges: { node: THREAD_FIELDS },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    'threads.listInbox',
  );

  const page = pageOf<WhatsappThreadRecord>(result.whatsappThreads);

  return { threads: page.items, nextCursor: page.nextCursor };
};

/** The 15-minute sweeper's read (FR-THR-5). */
export const findExpiredOpenWindows = async (
  now: Date,
  limit = 60,
): Promise<WhatsappThreadRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappThreads: {
          __args: {
            filter: {
              windowState: { eq: 'OPEN' },
              serviceWindowExpiresAt: { lt: now.toISOString() },
            },
            first: limit,
          },
          edges: { node: { id: true } },
        },
      }),
    'threads.findExpiredWindows',
  );

  return nodesOf<WhatsappThreadRecord>(result.whatsappThreads);
};
