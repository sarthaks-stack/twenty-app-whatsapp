import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MESSAGE_PAGE,
  FEED_SCOPE,
  INBOX_FILTER,
  MAX_MESSAGE_PAGE,
  parseFeedQuery,
} from './query';

/**
 * The front end's only server contract.
 *
 * The behaviour worth defending here is the refusal. Every one of these inputs
 * has a "reasonable" fallback — treat an unknown filter as `all`, an unparsable
 * `since` as a full load — and every one of those fallbacks answers a different
 * question from the one the caller asked. A rep looking at a screen labelled
 * "Minhas" while the server returned the whole workspace is the same failure as
 * D-34's unknown header format: an unrecognised value treated as a known one.
 */
describe('parseFeedQuery', () => {
  it('defaults to bootstrap with no parameters at all', () => {
    const result = parseFeedQuery({});

    expect(result).toEqual({
      ok: true,
      query: {
        scope: FEED_SCOPE.BOOTSTRAP,
        id: null,
        by: 'thread',
        since: null,
        filter: INBOX_FILTER.ALL,
        before: null,
        limit: DEFAULT_MESSAGE_PAGE,
      },
    });
  });

  it('refuses an unknown scope rather than guessing', () => {
    expect(parseFeedQuery({ scope: 'inbox_v2' })).toEqual({
      ok: false,
      error: 'Unknown scope: inbox_v2',
    });
  });

  it('refuses an unknown filter rather than widening it to all', () => {
    expect(parseFeedQuery({ scope: 'inbox', filter: 'mine ' })).toMatchObject({ ok: true });
    expect(parseFeedQuery({ scope: 'inbox', filter: 'assigned' })).toEqual({
      ok: false,
      error: 'Unknown filter: assigned',
    });
  });

  it('refuses an unknown `by`', () => {
    expect(parseFeedQuery({ scope: 'thread', id: 't', by: 'waId' })).toEqual({
      ok: false,
      error: 'Unknown by: waId',
    });
  });

  it('requires an id for scope=thread, because there is no default conversation', () => {
    expect(parseFeedQuery({ scope: 'thread' })).toEqual({
      ok: false,
      error: 'id is required for scope=thread',
    });
    expect(parseFeedQuery({ scope: 'thread', id: '   ' })).toEqual({
      ok: false,
      error: 'id is required for scope=thread',
    });
  });

  it('does not require an id for scope=campaign — that is the list', () => {
    expect(parseFeedQuery({ scope: 'campaign' })).toMatchObject({
      ok: true,
      query: { id: null },
    });
  });

  it('refuses a `since` that is not a timestamp', () => {
    expect(parseFeedQuery({ scope: 'thread', id: 't', since: 'yesterday' })).toEqual({
      ok: false,
      error: 'since is not a timestamp: yesterday',
    });
  });

  it('keeps a valid since verbatim, so the server never reformats the cursor', () => {
    const since = '2026-08-16T12:43:24.211Z';

    expect(parseFeedQuery({ scope: 'thread', id: 't', since })).toMatchObject({
      ok: true,
      query: { since },
    });
  });

  it('refuses a limit that is not a positive integer', () => {
    for (const limit of ['0', '-5', '2.5', 'fifty', '']) {
      const result = parseFeedQuery({ scope: 'thread', id: 't', limit });

      // An empty string is absence, not a bad value — it takes the default.
      if (limit === '') {
        expect(result).toMatchObject({ ok: true, query: { limit: DEFAULT_MESSAGE_PAGE } });
        continue;
      }

      expect(result.ok).toBe(false);
    }
  });

  it('caps the limit instead of letting a widget ask for the whole table', () => {
    expect(parseFeedQuery({ scope: 'thread', id: 't', limit: '100000' })).toMatchObject({
      ok: true,
      query: { limit: MAX_MESSAGE_PAGE },
    });
  });
});
