/**
 * Parsing and validating the feed's query string (specs/08 §2).
 *
 * Kept pure and separate from the route because this is where the front end's
 * only server contract is defined, and a contract that can only be exercised by
 * deploying is a contract nobody tests.
 *
 * Every unrecognised value is **refused**, never defaulted. A typo in `filter`
 * that quietly fell back to `all` would show a rep every conversation in the
 * workspace while their screen said "Minhas" — the same class of failure as
 * D-34 and D-40, where an unknown value was treated as a known one.
 */

export const FEED_SCOPE = {
  THREAD: 'thread',
  INBOX: 'inbox',
  CAMPAIGN: 'campaign',
  BOOTSTRAP: 'bootstrap',
} as const;
export type FeedScope = (typeof FEED_SCOPE)[keyof typeof FEED_SCOPE];

/**
 * `closed` is not in the specs/08 table. It is added here because `close` exists
 * precisely so an inbox filter can hide handled conversations — which makes the
 * other five filters exclude closed threads, and leaves no way to find one
 * again. A hidden state with no way back is a bug, not a feature.
 */
export const INBOX_FILTER = {
  MINE: 'mine',
  UNASSIGNED: 'unassigned',
  ALL: 'all',
  CAMPAIGN_REPLIES: 'campaign_replies',
  WINDOW_EXPIRING: 'window_expiring',
  CLOSED: 'closed',
} as const;
export type InboxFilter = (typeof INBOX_FILTER)[keyof typeof INBOX_FILTER];

/** `thread` resolves by thread id; `person` by Person id (FR-UI-3, the side panel). */
export const FEED_BY = { THREAD: 'thread', PERSON: 'person' } as const;
export type FeedBy = (typeof FEED_BY)[keyof typeof FEED_BY];

export const DEFAULT_MESSAGE_PAGE = 50;
export const MAX_MESSAGE_PAGE = 200;
export const DEFAULT_THREAD_PAGE = 50;

export type FeedQuery = {
  scope: FeedScope;
  id: string | null;
  by: FeedBy;
  since: string | null;
  filter: InboxFilter;
  before: string | null;
  limit: number;
  /**
   * Ask the inbox scope for a count per filter as well as the current page.
   *
   * Opt-in rather than always-on, and the reason is D-6. Counting six filters
   * means six more reads, and the inbox already polls every eight seconds; a
   * number beside "Fechadas" is not worth multiplying the workspace's query
   * load by seven, forever, on every open tab. The surface asks for it on a
   * much slower clock instead.
   */
  counts: boolean;
  /**
   * Campaign scope: ask for the **archive** instead of the live list.
   *
   * A parameter rather than a client-side filter because the list is a page of
   * 50 newest rows. Filtering in the browser would mean a workspace with 50
   * archived campaigns receives 50 hidden rows and shows an empty campaigns page
   * — the archive hiding the live campaigns instead of the past ones.
   */
  archived: boolean;
};

export type FeedQueryResult =
  | { ok: true; query: FeedQuery }
  | { ok: false; error: string };

const isOneOf = <T extends string>(
  values: Record<string, T>,
  candidate: string,
): candidate is T => Object.values<string>(values).includes(candidate);

const trimmed = (value: string | undefined): string | null => {
  if (typeof value !== 'string') return null;

  const text = value.trim();

  return text.length === 0 ? null : text;
};

export const parseFeedQuery = (
  params: Record<string, string | undefined>,
): FeedQueryResult => {
  const rawScope = trimmed(params.scope) ?? FEED_SCOPE.BOOTSTRAP;

  if (!isOneOf(FEED_SCOPE, rawScope)) {
    return { ok: false, error: `Unknown scope: ${rawScope}` };
  }

  const rawFilter = trimmed(params.filter) ?? INBOX_FILTER.ALL;

  if (!isOneOf(INBOX_FILTER, rawFilter)) {
    return { ok: false, error: `Unknown filter: ${rawFilter}` };
  }

  const rawBy = trimmed(params.by) ?? FEED_BY.THREAD;

  if (!isOneOf(FEED_BY, rawBy)) {
    return { ok: false, error: `Unknown by: ${rawBy}` };
  }

  const since = trimmed(params.since);

  if (since !== null && Number.isNaN(new Date(since).getTime())) {
    return { ok: false, error: `since is not a timestamp: ${since}` };
  }

  const rawLimit = trimmed(params.limit);
  let limit = DEFAULT_MESSAGE_PAGE;

  if (rawLimit !== null) {
    const parsed = Number(rawLimit);

    if (!Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, error: `limit is not a positive integer: ${rawLimit}` };
    }

    limit = Math.min(parsed, MAX_MESSAGE_PAGE);
  }

  const id = trimmed(params.id);

  if (id === null && (rawScope === FEED_SCOPE.THREAD)) {
    return { ok: false, error: 'id is required for scope=thread' };
  }

  /**
   * Refused rather than defaulted, like every other value here. `counts=yes`
   * silently meaning "no" is the failure this file exists to prevent.
   */
  const rawCounts = trimmed(params.counts);

  if (rawCounts !== null && rawCounts !== '1' && rawCounts !== '0') {
    return { ok: false, error: `counts must be 0 or 1: ${rawCounts}` };
  }

  const rawArchived = trimmed(params.archived);

  if (rawArchived !== null && rawArchived !== '1' && rawArchived !== '0') {
    return { ok: false, error: `archived must be 0 or 1: ${rawArchived}` };
  }

  return {
    ok: true,
    query: {
      scope: rawScope,
      id,
      by: rawBy,
      since,
      filter: rawFilter,
      before: trimmed(params.before),
      limit,
      counts: rawCounts === '1',
      archived: rawArchived === '1',
    },
  };
};
