import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { getApplicationVariable } from 'twenty-sdk/front-component';

import type {
  AccountProjection,
  MessageProjection,
  ThreadProjection,
} from '../../domain/feed/projection';
import { mergeMessages } from './merge';

/**
 * The one thing that talks to the server (specs/08 §2.1, D-6).
 *
 * Every surface polls through this hook, so the polling *policy* — how often,
 * when to stop, what to do after a failure — exists once. Five components each
 * with their own `setInterval` is how a CRM tab ends up making 40 requests a
 * second at 3 a.m. on a laptop nobody is looking at.
 *
 * Four mechanics are forced by the sandbox rather than chosen:
 *
 * - **Skip, never stack.** `AbortSignal` is dropped here, so a slow request
 *   cannot be cancelled. A tick that finds one in flight does nothing at all;
 *   otherwise a server having a bad minute would be met with a queue that grows
 *   for as long as it stays slow.
 * - **A timeout chain, not an interval.** Backoff and the focused/blurred switch
 *   are then just the next delay, and no tick can ever overlap the one before.
 * - **Interaction, not `window.blur`.** `window.addEventListener('blur')` never
 *   fires in this sandbox, so "is anyone watching" is answered by whether
 *   anything has been touched recently — which is the question that was actually
 *   being asked.
 * - **Merge, never replace.** Deltas arrive by message id; an optimistic bubble
 *   is keyed by its `clientToken` so the server's version replaces it instead of
 *   appearing beside it.
 */

export type FeedScopeName = 'thread' | 'inbox' | 'campaign' | 'bootstrap';

export type FeedPermissions = {
  canSend: boolean;
  canManageTemplates: boolean;
  canManageCampaigns: boolean;
  /** The caller's own workspace member id, as resolved by the server (D-53). */
  workspaceMemberId: string | null;
};

export type FeedPolicy = {
  allowed: boolean;
  reason: string | null;
  warnings: string[];
};

export type FeedTemplate = {
  id: string;
  name: string | null;
  language: string | null;
  category: string | null;
  qualityScore: string | null;
  variableSpec: Record<string, unknown> | null;
  components: Record<string, unknown> | null;
};

export type FeedEnvelope = {
  serverTime: string;
  nextSince: string;
  truncated?: boolean;
  scope: string;
  permissions: FeedPermissions;
  account?: AccountProjection | null;
  accounts?: AccountProjection[];
  thread?: ThreadProjection | null;
  threads?: ThreadProjection[];
  messages?: MessageProjection[];
  olderCursor?: string | null;
  nextCursor?: string | null;
  policy?: FeedPolicy;
  templates?: FeedTemplate[];
  campaign?: Record<string, unknown>;
  campaigns?: Record<string, unknown>[];
  recipients?: Record<string, unknown>[];
};

export type UseFeedOptions = {
  scope: FeedScopeName;
  id?: string | null;
  by?: 'thread' | 'person';
  filter?: string;
  /** Overrides the application variable; used by the inbox, which is slower. */
  intervalMs?: number;
  /** Set false while a surface is not mounted or has nothing to ask for. */
  enabled?: boolean;
};

export type UseFeedResult = {
  data: FeedEnvelope | null;
  messages: MessageProjection[];
  error: string | null;
  /** True once a poll has failed and the data on screen predates it. */
  isStale: boolean;
  /** True after fifteen quiet minutes; nothing is fetched until `resume`. */
  isSuspended: boolean;
  isLoading: boolean;
  hasOlder: boolean;
  refresh: () => void;
  resume: () => void;
  loadOlder: () => void;
  /**
   * Adds a bubble before the server has one, keyed by `clientToken` so the
   * server's row replaces it rather than doubling it.
   */
  addOptimistic: (message: MessageProjection) => void;
  /** Spread onto the surface's root element to keep the "watching" signal fed. */
  rootProps: {
    onPointerDown: () => void;
    onPointerMove: () => void;
    onKeyDown: () => void;
    onFocus: () => void;
    onScroll: () => void;
  };
};

const numberVariable = (name: string, fallback: number): number => {
  const raw = getApplicationVariable(name);
  const parsed = raw === undefined ? Number.NaN : Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Fifteen quiet minutes and the tab stops asking entirely (D-6). */
export const SUSPEND_AFTER_MS = 15 * 60 * 1000;
/** Untouched for a minute counts as "not watching", and the interval widens. */
export const BLURRED_AFTER_MS = 60 * 1000;
export const MAX_BACKOFF_MS = 60 * 1000;

export const useFeed = ({
  scope,
  id = null,
  by,
  filter,
  intervalMs,
  enabled = true,
}: UseFeedOptions): UseFeedResult => {
  const [data, setData] = useState<FeedEnvelope | null>(null);
  const [messages, setMessages] = useState<MessageProjection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSuspended, setIsSuspended] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);

  const client = useMemo(() => new RestApiClient(), []);
  const inFlight = useRef(false);
  const since = useRef<string | null>(null);
  const olderCursor = useRef<string | null>(null);
  const failures = useRef(0);
  const lastTouch = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped whenever what we are looking at changes, to void an in-flight reply. */
  const generation = useRef(0);

  const focusedInterval =
    intervalMs ??
    (scope === 'inbox'
      ? numberVariable('WA_POLL_INTERVAL_INBOX_MS', 8_000)
      : numberVariable('WA_POLL_INTERVAL_THREAD_MS', 3_000));
  const blurredInterval = numberVariable('WA_POLL_INTERVAL_BLURRED_MS', 20_000);

  const touch = useCallback(() => {
    lastTouch.current = Date.now();
  }, []);

  const fetchOnce = useCallback(
    async (mode: 'full' | 'delta' | 'older'): Promise<void> => {
      if (inFlight.current) return;

      inFlight.current = true;

      const mine = generation.current;

      if (mode !== 'delta') setIsLoading(true);

      try {
        const query: Record<string, string> = { scope };

        if (id !== null) query.id = id;
        if (by !== undefined) query.by = by;
        if (filter !== undefined) query.filter = filter;
        if (mode === 'delta' && since.current !== null) query.since = since.current;
        if (mode === 'older' && olderCursor.current !== null) {
          query.before = olderCursor.current;
        }

        const envelope = await client.get<FeedEnvelope>('/s/whatsapp/feed', { query });

        // The reply to a question we are no longer asking — a different thread
        // was opened while it was in flight.
        if (mine !== generation.current) return;

        failures.current = 0;
        setError(null);

        /**
         * An *older* page must not move the delta cursor. It is a read of the
         * past; treating its `nextSince` as the present would skip everything
         * that arrived while the reader was scrolling up.
         */
        if (mode !== 'older') since.current = envelope.nextSince;

        if (mode === 'older') {
          olderCursor.current = envelope.olderCursor ?? null;
          setHasOlder(envelope.olderCursor !== null && envelope.olderCursor !== undefined);
          setMessages((current) =>
            mergeMessages(current, envelope.messages ?? [], { append: true }),
          );

          return;
        }

        setData(envelope);

        if (mode === 'full') {
          olderCursor.current = envelope.olderCursor ?? null;
          setHasOlder(envelope.olderCursor !== null && envelope.olderCursor !== undefined);
          setMessages(envelope.messages ?? []);
        } else if ((envelope.messages ?? []).length > 0) {
          setMessages((current) => mergeMessages(current, envelope.messages ?? []));
        }

        /**
         * A truncated delta means the server stopped part-way through a burst.
         * Asking again immediately is the point of saying so.
         */
        if (envelope.truncated === true) {
          inFlight.current = false;
          await fetchOnce('delta');
        }
      } catch (caught) {
        if (mine !== generation.current) return;

        failures.current += 1;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        inFlight.current = false;
        setIsLoading(false);
      }
    },
    [by, client, filter, id, scope],
  );

  const refresh = useCallback(() => {
    touch();
    void fetchOnce(since.current === null ? 'full' : 'delta');
  }, [fetchOnce, touch]);

  const resume = useCallback(() => {
    touch();
    setIsSuspended(false);
  }, [touch]);

  const loadOlder = useCallback(() => {
    touch();

    if (olderCursor.current !== null) void fetchOnce('older');
  }, [fetchOnce, touch]);

  const addOptimistic = useCallback((message: MessageProjection) => {
    setMessages((current) => mergeMessages(current, [message]));
  }, []);

  // A change of subject starts over: new cursor, empty list, and any reply
  // still in flight is discarded rather than merged into the wrong thread.
  useEffect(() => {
    generation.current += 1;
    since.current = null;
    olderCursor.current = null;
    failures.current = 0;
    setMessages([]);
    setData(null);
    setHasOlder(false);
  }, [scope, id, by, filter]);

  useEffect(() => {
    if (!enabled || isSuspended) return;

    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (cancelled) return;

      if (Date.now() - lastTouch.current > SUSPEND_AFTER_MS) {
        setIsSuspended(true);

        return;
      }

      await fetchOnce(since.current === null ? 'full' : 'delta');

      if (cancelled) return;

      const quiet = Date.now() - lastTouch.current > BLURRED_AFTER_MS;
      const base = quiet ? blurredInterval : focusedInterval;
      /**
       * Doubling per failure, capped. A server that is down should be asked
       * once a minute, not three times a second by every open tab — that is the
       * shape that turns an outage into an outage nobody can deploy out of.
       */
      const delay =
        failures.current === 0
          ? base
          : Math.min(base * 2 ** failures.current, MAX_BACKOFF_MS);

      timer.current = setTimeout(() => void tick(), delay);
    };

    void tick();

    return () => {
      cancelled = true;

      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [enabled, isSuspended, fetchOnce, blurredInterval, focusedInterval]);

  const rootProps = useMemo(
    () => ({
      onPointerDown: touch,
      onPointerMove: touch,
      onKeyDown: touch,
      onFocus: touch,
      onScroll: touch,
    }),
    [touch],
  );

  return {
    data,
    messages,
    error,
    isStale: error !== null && data !== null,
    isSuspended,
    isLoading,
    hasOlder,
    refresh,
    resume,
    loadOlder,
    addOptimistic,
    rootProps,
  };
};
