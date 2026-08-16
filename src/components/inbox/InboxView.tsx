import { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { ThreadProjection } from '../../domain/feed/projection';
import { useCopy } from '../common/copy';
import { ActionButton } from '../common/ui';
import { countdown, displayPhone, relativeTime } from '../common/format';
import { SURFACE_MAX_HEIGHT, SURFACE_MIN_HEIGHT } from '../common/surface';
import { InboundToaster } from './InboundToaster';
import { useFeed } from '../common/use-feed';
import { ThreadView } from '../chat/ThreadView';

/**
 * The inbox (FR-UI-2, specs/08 §4).
 *
 * **Layout.** Two panes when there is room, list-then-detail when there is not.
 * The width is read from `node.clientWidth` and re-read on every render, which
 * the poll causes anyway. `ResizeObserver` and `matchMedia` are both undefined
 * here, and `@media` would answer for the browser window rather than for a
 * widget that may be a third of it. A resize between polls therefore lags by up
 * to one interval; that is the cost of the only measurement this sandbox
 * offers — and P-6 found it is not the one the docs name (see `measure`).
 *
 * **No virtualisation.** Every windowing library measures with the observers
 * that throw here. Fifty rows and a "Carregar mais" is the design that works.
 */

export const TWO_PANE_MIN_WIDTH = 720;

/** The six the feed route accepts; the labels come from the catalog. */
const FILTERS = [
  'mine',
  'unassigned',
  'all',
  'campaign_replies',
  'window_expiring',
  'closed',
] as const;

const ThreadRow = ({
  thread,
  selected,
  onSelect,
  now,
  lang,
}: {
  thread: ThreadProjection;
  selected: boolean;
  onSelect: () => void;
  now: Date;
  lang: 'pt' | 'en';
}) => {
  const theme = useTheme();
  const remaining = countdown(thread.serviceWindowExpiresAt, now);

  const name =
    thread.profileName ??
    (thread.person === null
      ? displayPhone(thread.dialablePhone ?? thread.waId)
      : [thread.person.firstName, thread.person.lastName].filter(Boolean).join(' '));

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={name}
      aria-current={selected}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[0.5],
        width: '100%',
        textAlign: 'left',
        border: 'none',
        borderBottom: `1px solid ${theme.border.color.light}`,
        background: selected ? theme.background.transparent.light : 'transparent',
        color: theme.font.color.primary,
        cursor: 'pointer',
        padding: theme.spacing[2],
        fontFamily: theme.font.family,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'baseline', gap: theme.spacing[1] }}>
        <span
          style={{
            fontWeight:
              (thread.unreadCount ?? 0) > 0
                ? theme.font.weight.semiBold
                : theme.font.weight.regular,
            fontSize: theme.font.size.md,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name === '' ? displayPhone(thread.waId) : name}
        </span>
        <span style={{ flex: '1 1 auto' }} />
        <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
          {relativeTime(thread.lastMessageAt, now, lang)}
        </span>
      </span>

      <span
        style={{
          fontSize: theme.font.size.sm,
          color: theme.font.color.tertiary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '100%',
        }}
      >
        {thread.lastMessageDirection === 'OUTBOUND' ? '↗ ' : '↙ '}
        {thread.lastMessagePreview ?? ''}
      </span>

      <span style={{ display: 'flex', gap: theme.spacing[1], flexWrap: 'wrap' }}>
        {(thread.unreadCount ?? 0) > 0 ? (
          <span
            style={{
              fontSize: theme.font.size.xs,
              background: theme.color.blue,
              color: theme.font.color.inverted,
              borderRadius: theme.border.radius.pill,
              padding: `0 ${theme.spacing[1]}`,
            }}
          >
            {thread.unreadCount}
          </span>
        ) : null}
        {remaining === null ? null : (
          <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
            🟢 {remaining}
          </span>
        )}
        {thread.originCampaignId === null ? null : (
          <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
            📣
          </span>
        )}
        {thread.status === 'NEEDS_REVIEW' ? (
          <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
            ❓
          </span>
        ) : null}
      </span>
    </button>
  );
};

export const InboxView = () => {
  const theme = useTheme();
  const { t, lang } = useCopy();

  const [filter, setFilter] = useState<string>('mine');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wide, setWide] = useState(true);

  const measured = useRef<boolean | null>(null);
  const node = useRef<HTMLDivElement | null>(null);

  const feed = useFeed({ scope: 'inbox', filter });

  /**
   * Decides the layout from the widget's own width.
   *
   * `clientWidth`, not `getBoundingClientRect()`. Probe P-6 found the rect API
   * returns **0×0** here — it exists, it does not throw, and it lies — while
   * `scrollHeight` and `clientHeight` on the same node return real numbers. So
   * the layout box is there and only that one API is unimplemented; measuring
   * through it meant every inbox, at every width, silently took the narrow
   * branch.
   *
   * `window.innerWidth` is the backstop rather than the primary: it answers for
   * the whole browser window (1680 where the widget was 1030), which is right
   * only because this surface is a full-width standalone page. If the node can
   * speak for itself, it does.
   */
  const measure = useCallback(() => {
    const element = node.current;

    if (element === null) return;

    try {
      const width =
        element.clientWidth > 0
          ? element.clientWidth
          : typeof window === 'undefined'
            ? 0
            : (window.innerWidth ?? 0);

      const isWide = width >= TWO_PANE_MIN_WIDTH;

      if (measured.current !== isWide) {
        measured.current = isWide;
        setWide(isWide);
      }
    } catch {
      // A sandbox that will not measure gets the single-pane layout, which
      // works at every width. Failing towards the narrow design is the safe
      // direction: two panes in 320 pixels is unusable, one pane in 1400 is
      // merely roomy.
      measured.current = false;
      setWide(false);
    }
  }, []);

  /**
   * Re-measured after **every** render, which the poll guarantees at least
   * every few seconds, and again on `resize` if that event reaches the sandbox.
   *
   * The previous version was a `useCallback(…, [])` ref callback, which React
   * invokes only when the node is attached — so the inbox measured itself once
   * and never again, and dragging the window did nothing until a reload.
   * `ResizeObserver` is the right tool and is undefined here (P-6), so the
   * listener is attempted and its absence tolerated: `window.blur` is known not
   * to fire in this sandbox, and `resize` may well be the same. The
   * every-render pass is what actually holds the guarantee; the listener only
   * removes the lag when it works.
   */
  useEffect(() => {
    measure();
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }

    try {
      window.addEventListener('resize', measure);

      return () => window.removeEventListener('resize', measure);
    } catch {
      return;
    }
  }, [measure]);

  const threads = feed.data?.threads ?? [];
  const account = feed.data?.account ?? null;
  const now = new Date(feed.data?.serverTime ?? Date.now());

  const showList = wide || selectedId === null;
  const showDetail = wide || selectedId !== null;

  return (
    <div
      className="wa-inbox"
      ref={node}
      {...feed.rootProps}
      style={{
        display: 'flex',
        flexDirection: 'column',
        /**
         * A height, not a percentage. The page sizes itself to us rather than
         * the other way round, so `100%` resolves to `auto` and the inbox would
         * be as tall as its content — a two-row list in a 400px box on a
         * 1400px screen, and a page-scrolling column when the list is long.
         * See `SURFACE_MAX_HEIGHT`.
         */
        height: SURFACE_MAX_HEIGHT,
        minHeight: SURFACE_MIN_HEIGHT,
        background: theme.background.primary,
        color: theme.font.color.primary,
        fontFamily: theme.font.family,
        overflow: 'hidden',
      }}
    >
      {/* Renders nothing; polls `mine` and raises the snackbars (D-10 layer 2). */}
      <InboundToaster />

      {account !== null && account.status !== 'CONNECTED' ? (
        <div
          role="status"
          style={{
            padding: theme.spacing[2],
            fontSize: theme.font.size.md,
            background: theme.background.transparent.danger,
            color: theme.font.color.danger,
          }}
        >
          ⚠ {t('chat.accountError')}
        </div>
      ) : null}

      {account?.qualityRating === 'RED' || account?.qualityRating === 'YELLOW' ? (
        <div
          role="status"
          style={{
            padding: theme.spacing[2],
            fontSize: theme.font.size.md,
            background: theme.background.transparent.light,
            color: theme.font.color.secondary,
          }}
        >
          {account.qualityRating === 'RED' ? t('chat.qualityRed') : t('chat.qualityYellow')}
          {account.isTestAccount ? ` · ${t('chat.testAccount')}` : ''}
        </div>
      ) : null}

      {feed.isStale ? (
        <div
          role="status"
          style={{
            padding: theme.spacing[2],
            fontSize: theme.font.size.md,
            background: theme.background.transparent.danger,
            color: theme.font.color.danger,
          }}
        >
          {t('chat.offline')}
        </div>
      ) : null}

      <div
        style={{
          display: 'flex',
          gap: theme.spacing[1],
          padding: theme.spacing[1],
          overflowX: 'auto',
          borderBottom: `1px solid ${theme.border.color.light}`,
        }}
      >
        {/*
          Kept as `aria-pressed` toggles rather than `twenty-ui` chips, which
          carry no pressed state — but at chip scale: `sm` text and a 24px+
          box, not the 16px-high 8px-type pills the review measured.
        */}
        {FILTERS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
            style={{
              border: `1px solid ${
                filter === key ? theme.border.color.strong : theme.border.color.light
              }`,
              borderRadius: theme.border.radius.pill,
              background:
                filter === key ? theme.background.transparent.light : 'transparent',
              color: filter === key ? theme.font.color.primary : theme.font.color.secondary,
              cursor: 'pointer',
              fontFamily: theme.font.family,
              fontSize: theme.font.size.sm,
              fontWeight: filter === key ? theme.font.weight.medium : theme.font.weight.regular,
              padding: `${theme.spacing[1]} ${theme.spacing[3]}`,
              whiteSpace: 'nowrap',
            }}
          >
            {t(`inbox.${key}`)}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flex: '1 1 auto', minHeight: 0 }}>
        {showList ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              overflowY: 'auto',
              flex: wide ? '0 0 320px' : '1 1 auto',
              borderRight: wide ? `1px solid ${theme.border.color.light}` : 'none',
              minHeight: 0,
            }}
          >
            {/*
              "No conversations in this filter" is a claim about the data, and
              a surface that could not read anything is not entitled to make
              it. The three states are kept apart: unreadable, still reading,
              and genuinely empty.
            */}
            {feed.isUnavailable ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: theme.spacing[2],
                  padding: theme.spacing[4],
                  textAlign: 'center',
                }}
              >
                <span style={{ color: theme.font.color.danger, fontSize: theme.font.size.md }}>
                  {t('common.unavailable')}
                </span>
                <span
                  style={{ color: theme.font.color.tertiary, fontSize: theme.font.size.sm }}
                >
                  {feed.error}
                </span>
                <ActionButton label={t('common.retry')} onClick={feed.refresh} />
              </div>
            ) : feed.isLoading && feed.data === null ? (
              <div
                style={{
                  padding: theme.spacing[4],
                  textAlign: 'center',
                  color: theme.font.color.tertiary,
                  fontSize: theme.font.size.md,
                }}
              >
                {t('common.loading')}
              </div>
            ) : threads.length === 0 && !feed.isLoading ? (
              <div
                style={{
                  padding: theme.spacing[4],
                  textAlign: 'center',
                  color: theme.font.color.tertiary,
                  fontSize: theme.font.size.md,
                }}
              >
                {t('inbox.empty')}
              </div>
            ) : null}

            {threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                selected={thread.id === selectedId}
                onSelect={() => setSelectedId(thread.id)}
                now={now}
                lang={lang}
              />
            ))}
          </div>
        ) : null}

        {showDetail ? (
          <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
            {!wide && selectedId !== null ? (
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label={t('common.back')}
                style={{
                  alignSelf: 'flex-start',
                  border: 'none',
                  background: 'transparent',
                  color: theme.font.color.secondary,
                  cursor: 'pointer',
                  fontFamily: theme.font.family,
                  fontSize: theme.font.size.md,
                  padding: theme.spacing[2],
                }}
              >
                ← {t('inbox.conversations')}
              </button>
            ) : null}

            {selectedId === null ? (
              <div
                style={{
                  margin: 'auto',
                  color: theme.font.color.tertiary,
                  fontSize: theme.font.size.md,
                }}
              >
                {t('inbox.pick')}
              </div>
            ) : (
              <ThreadView threadId={selectedId} variant="inbox" />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};
