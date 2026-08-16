import { defineLogicFunction } from 'twenty-sdk/define';
import { Response, type RoutePayload } from 'twenty-sdk/logic-function';

import { LF_INBOX_FEED_ROUTE } from '../constants/universal-identifiers';
import {
  ACCOUNT_STATUS,
  CONSENT_STATUS,
  LANE,
  QUALITY,
  type AccountStatus,
  type ConsentStatus,
  type Quality,
} from '../domain/constants';
import {
  DEFAULT_THREAD_PAGE,
  FEED_BY,
  FEED_SCOPE,
  INBOX_FILTER,
  parseFeedQuery,
  type FeedQuery,
} from '../domain/feed/query';
import {
  projectAccount,
  projectMessage,
  projectPerson,
  projectThread,
  type AccountProjection,
  type MessageProjection,
  type ThreadProjection,
} from '../domain/feed/projection';
import {
  evaluateSendPermission,
  type SendContext,
  type SendVerdict,
} from '../domain/policy/send-permission';
import { authErrorResponse, requireCaller, requireRole, type Caller } from '../server/auth';
import { describeError, logger } from '../server/logger';
import { findAccountById, listAccounts } from '../server/repositories/accounts';
import { toDate } from '../server/repositories/base';
import { findCampaignById, listCampaigns } from '../server/repositories/campaigns';
import { listRecipients } from '../server/repositories/campaign-recipients';
import {
  listThreadMessages,
  listThreadMessagesSince,
} from '../server/repositories/messages';
import { findPersonById } from '../server/repositories/people';
import { listTemplatesForAccount } from '../server/repositories/templates';
import {
  findThreadById,
  findThreadsForPerson,
  listInboxThreads,
  type InboxFilterSpec,
} from '../server/repositories/threads';

/**
 * `GET /s/whatsapp/feed` — the single data path every front component reads
 * (specs/08 §2, D-6, FR-UI-4).
 *
 * Five surfaces polling five different endpoints would multiply the request
 * budget by five and give each of them its own idea of what the window rule is.
 * One route, one envelope, one refresh — and the two things the UI must never
 * decide for itself, `policy` and `permissions`, are computed here where the
 * send route computes them too (AR-17, SEC-5).
 *
 * The transport is polling, which is the seam FR-UI-4 asks for: the components
 * consume an envelope, not a socket, so replacing this with a subscription later
 * changes one hook.
 */

export const WINDOW_EXPIRING_HORIZON_MS = 2 * 60 * 60 * 1000;
/** Campaign counters are read from the record; this caps the recipient sample. */
export const RECIPIENT_SAMPLE = 50;

export type FeedPermissions = {
  canSend: boolean;
  canManageTemplates: boolean;
  canManageCampaigns: boolean;
};

export type FeedPolicy = {
  allowed: boolean;
  reason: string | null;
  warnings: string[];
};

export type FeedEnvelope = {
  /** The clock when the read *started* — see `nextSince`. */
  serverTime: string;
  /** What to send back as `since` on the next poll. */
  nextSince: string;
  /** True when a burst did not fit in one delta; poll again immediately. */
  truncated?: boolean;
  scope: string;
  permissions: FeedPermissions;
  account?: AccountProjection | null;
  thread?: ThreadProjection | null;
  threads?: ThreadProjection[];
  messages?: MessageProjection[];
  olderCursor?: string | null;
  nextCursor?: string | null;
  policy?: FeedPolicy;
  templates?: unknown[];
  campaign?: unknown;
  campaigns?: unknown[];
  recipients?: unknown[];
  accounts?: AccountProjection[];
};

export const permissionsFor = (caller: Caller): FeedPermissions => ({
  canSend: caller.isAgent,
  canManageTemplates: caller.isAdmin,
  canManageCampaigns: caller.isAdmin,
});

const asPolicy = (verdict: SendVerdict): FeedPolicy => ({
  allowed: verdict.allowed,
  reason: verdict.allowed ? null : verdict.reason,
  warnings: verdict.warnings,
});

/**
 * The composer's state, decided here rather than in the browser (AR-17).
 *
 * The intent is free-form: the question the composer is asking is "can I type a
 * message and press send". A closed window answers `WINDOW_CLOSED`, which is
 * exactly the state that swaps the primary button for **Escolher modelo**
 * (FR-OUT-2), so the denial is the instruction.
 */
export const threadPolicy = (
  thread: { serviceWindowExpiresAt?: string | null; isBlocked?: boolean | null },
  account: { status?: string | null; qualityRating?: string | null } | null,
  person: { whatsappOptInStatus?: string | null } | null,
  now: Date,
): FeedPolicy => {
  const context: SendContext = {
    now,
    thread: {
      serviceWindowExpiresAt: toDate(thread.serviceWindowExpiresAt),
      isBlocked: thread.isBlocked === true,
    },
    person:
      person === null
        ? null
        : {
            whatsappOptInStatus: (person.whatsappOptInStatus ??
              CONSENT_STATUS.UNKNOWN) as ConsentStatus,
          },
    account: {
      status: (account?.status ?? ACCOUNT_STATUS.PENDING) as AccountStatus,
      qualityRating: (account?.qualityRating ?? QUALITY.UNKNOWN) as Quality,
    },
  };

  return asPolicy(
    evaluateSendPermission({ kind: 'FREEFORM', lane: LANE.INTERACTIVE }, context),
  );
};

export const inboxSpecFor = (
  query: FeedQuery,
  caller: Caller,
  now: Date,
): InboxFilterSpec | { error: string } => {
  switch (query.filter) {
    case INBOX_FILTER.MINE:
      return caller.workspaceMemberId === null
        ? { error: 'filter=mine needs a workspace member; this caller has none' }
        : { kind: 'mine', assigneeId: caller.workspaceMemberId };
    case INBOX_FILTER.UNASSIGNED:
      return { kind: 'unassigned' };
    case INBOX_FILTER.CAMPAIGN_REPLIES:
      return { kind: 'campaign_replies' };
    case INBOX_FILTER.WINDOW_EXPIRING:
      return {
        kind: 'window_expiring',
        now,
        horizon: new Date(now.getTime() + WINDOW_EXPIRING_HORIZON_MS),
      };
    case INBOX_FILTER.CLOSED:
      return { kind: 'closed' };
    default:
      return { kind: 'all' };
  }
};

/**
 * The account a surface should show.
 *
 * A thread names its own; everything else takes the first connected number,
 * falling back to the first of any status so a workspace mid-setup sees its
 * pending account rather than an empty banner.
 */
const resolveAccount = async (accountId: string | null | undefined) => {
  if (typeof accountId === 'string' && accountId.length > 0) {
    return findAccountById(accountId);
  }

  const accounts = await listAccounts();

  return (
    accounts.find((account) => account.status === ACCOUNT_STATUS.CONNECTED) ??
    accounts[0] ??
    null
  );
};

/**
 * Only templates a rep may actually pick (FR-TPL-2, FR-TPL-3).
 *
 * Publishing is the deliberate human act that makes a template selectable, and
 * `isUsableInCrm` is the app's own verdict on whether it can render one — a
 * template with an unsupported header is approved at Meta and still unusable
 * here. Sending both and letting the picker filter would put that rule in two
 * places.
 */
const publishedTemplates = async (accountId: string | null | undefined) => {
  if (typeof accountId !== 'string' || accountId.length === 0) return [];

  const templates = await listTemplatesForAccount(accountId);

  return templates
    .filter(
      (template) =>
        template.publishedToCrm === true &&
        template.isUsableInCrm === true &&
        template.status === 'APPROVED',
    )
    .map((template) => ({
      id: template.id,
      name: template.name ?? null,
      language: template.language ?? null,
      category: template.category ?? null,
      qualityScore: template.qualityScore ?? null,
      variableSpec: template.variableSpec ?? null,
      components: template.components ?? null,
    }));
};

const threadScope = async (
  query: FeedQuery,
  caller: Caller,
  now: Date,
): Promise<FeedEnvelope | { status: number; error: string }> => {
  const id = query.id ?? '';

  const thread =
    query.by === FEED_BY.PERSON
      ? ((await findThreadsForPerson(id, 1))[0] ?? null)
      : await findThreadById(id);

  if (thread === null) {
    /**
     * A Person with no conversation is not an error — it is the side panel's
     * empty state, which offers "Iniciar conversa" (specs/08 §7). Answering 404
     * would make the component treat a normal contact as a failure.
     */
    if (query.by === FEED_BY.PERSON) {
      const fallback = await resolveAccount(null);

      return {
        serverTime: now.toISOString(),
        nextSince: now.toISOString(),
        scope: FEED_SCOPE.THREAD,
        permissions: permissionsFor(caller),
        thread: null,
        messages: [],
        account: projectAccount(fallback),
        templates: await publishedTemplates(fallback?.id),
      };
    }

    return { status: 404, error: 'Unknown thread' };
  }

  const account = await resolveAccount(thread.accountId);
  const person =
    typeof thread.personId === 'string' ? await findPersonById(thread.personId) : null;

  const isDelta = query.since !== null;

  const page = isDelta
    ? await listThreadMessagesSince(thread.id, query.since!, now.toISOString())
    : await listThreadMessages(thread.id, { limit: query.limit, before: query.before });

  const messages = page.messages.map(projectMessage);

  return {
    serverTime: now.toISOString(),
    nextSince: 'nextSince' in page ? page.nextSince : now.toISOString(),
    ...('truncated' in page && page.truncated ? { truncated: true } : {}),
    scope: FEED_SCOPE.THREAD,
    permissions: permissionsFor(caller),
    account: projectAccount(account),
    thread: projectThread(thread, projectPerson(person)),
    messages,
    olderCursor: 'olderCursor' in page ? page.olderCursor : null,
    policy: threadPolicy(thread, account, person, now),
    /**
     * The catalogue rides along on a full load and never on a delta. The picker
     * needs it the moment the window is closed, and re-sending sixty templates
     * every three seconds to say nothing changed is exactly the polling cost
     * D-6 exists to control.
     */
    ...(isDelta ? {} : { templates: await publishedTemplates(account?.id) }),
  };
};

const inboxScope = async (
  query: FeedQuery,
  caller: Caller,
  now: Date,
): Promise<FeedEnvelope | { status: number; error: string }> => {
  const spec = inboxSpecFor(query, caller, now);

  if ('error' in spec) return { status: 400, error: spec.error };

  const page = await listInboxThreads(spec, {
    limit: Math.min(query.limit, DEFAULT_THREAD_PAGE),
    after: query.before,
  });

  const account = await resolveAccount(null);

  return {
    serverTime: now.toISOString(),
    nextSince: now.toISOString(),
    scope: FEED_SCOPE.INBOX,
    permissions: permissionsFor(caller),
    account: projectAccount(account),
    threads: page.threads.map((thread) => projectThread(thread)),
    nextCursor: page.nextCursor,
  };
};

const campaignScope = async (
  query: FeedQuery,
  caller: Caller,
  now: Date,
): Promise<FeedEnvelope | { status: number; error: string }> => {
  const base = {
    serverTime: now.toISOString(),
    nextSince: now.toISOString(),
    scope: FEED_SCOPE.CAMPAIGN,
    permissions: permissionsFor(caller),
  };

  if (query.id === null) {
    return { ...base, campaigns: await listCampaigns(DEFAULT_THREAD_PAGE) };
  }

  const campaign = await findCampaignById(query.id);

  if (campaign === null) return { status: 404, error: 'Unknown campaign' };

  /**
   * The recipient sample is a *sample*, and says so. The detail view's table is
   * paged by status; loading a 100 000-row snapshot into a widget to count it
   * would spend the whole request budget on a number the campaign record
   * already carries.
   */
  const recipients = await listRecipients({
    campaignId: campaign.id,
    limit: RECIPIENT_SAMPLE,
  });

  return {
    ...base,
    campaign,
    recipients,
    account: projectAccount(await resolveAccount(campaign.accountId)),
  };
};

const bootstrapScope = async (caller: Caller, now: Date): Promise<FeedEnvelope> => {
  const accounts = await listAccounts();
  const account =
    accounts.find((candidate) => candidate.status === ACCOUNT_STATUS.CONNECTED) ??
    accounts[0] ??
    null;

  return {
    serverTime: now.toISOString(),
    nextSince: now.toISOString(),
    scope: FEED_SCOPE.BOOTSTRAP,
    permissions: permissionsFor(caller),
    account: projectAccount(account),
    accounts: accounts
      .map((candidate) => projectAccount(candidate))
      .filter((candidate): candidate is AccountProjection => candidate !== null),
    templates: await publishedTemplates(account?.id),
  };
};

export const handler = async (event: RoutePayload): Promise<Response> => {
  const log = logger.child({ fn: 'wa-inbox-feed-route' });

  try {
    const caller = await requireCaller(event);

    requireRole(caller, 'agent');

    const parsed = parseFeedQuery(event.queryStringParameters ?? {});

    if (!parsed.ok) return new Response({ error: parsed.error }, { status: 400 });

    /**
     * Captured before the first read, and returned as `nextSince`.
     *
     * Taking the clock *after* the queries would silently skip every row
     * written while they ran: the client would ask for changes since a moment
     * that had already passed, and a message that arrived mid-read would never
     * appear until something else in the thread changed.
     */
    const now = new Date();
    const query = parsed.query;

    const result =
      query.scope === FEED_SCOPE.THREAD
        ? await threadScope(query, caller, now)
        : query.scope === FEED_SCOPE.INBOX
          ? await inboxScope(query, caller, now)
          : query.scope === FEED_SCOPE.CAMPAIGN
            ? await campaignScope(query, caller, now)
            : await bootstrapScope(caller, now);

    if ('error' in result) {
      return new Response({ error: result.error }, { status: result.status });
    }

    return new Response(result, { status: 200 });
  } catch (error) {
    const authFailure = authErrorResponse(error);

    if (authFailure !== null) {
      return new Response(authFailure.body, { status: authFailure.status });
    }

    log.error('wa.feed.route_failed', describeError(error));

    return new Response({ error: 'Internal error' }, { status: 500 });
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_INBOX_FEED_ROUTE,
  name: 'wa-inbox-feed-route',
  description:
    'The single aggregated read every WhatsApp front component polls: thread, inbox, campaign and bootstrap scopes.',
  timeoutSeconds: 20,
  httpRouteTriggerSettings: {
    path: '/whatsapp/feed',
    httpMethod: 'GET',
    isAuthRequired: true,
  },
  handler,
});
