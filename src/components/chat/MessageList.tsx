import { useCallback, useMemo, useRef } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { MessageProjection } from '../../domain/feed/projection';
import type { Lang, Translate } from '../common/copy';
import { dayKey, daySeparator } from '../common/format';
import { MessageBubble } from './MessageBubble';

/**
 * The transcript (specs/08 §3.1, D-7, NFR-P4).
 *
 * There is no scripted scrolling in this file, and there cannot be: the sandbox
 * throws on `.scrollIntoView()` and ignores writes to `scrollTop`. The whole
 * design rests on `flex-direction: column-reverse`, where the browser's own
 * anchoring keeps the visual bottom pinned as rows are added to the *start* of
 * the array, and preserves the reader's position when older rows are added to
 * the *end*. The messages are therefore held newest-first — not sorted for
 * display, but stored that way, so the DOM order and the array order agree.
 *
 * Day separators are computed during render rather than stored, because the day
 * a message belongs to depends on the reader's time zone rule (Africa/Luanda)
 * and not on anything the server can bake in.
 */

export type MessageListProps = {
  messages: MessageProjection[];
  lang: Lang;
  t: Translate;
  now: Date;
  hasOlder: boolean;
  isLoading: boolean;
  onLoadOlder: () => void;
  onRetry?: (message: MessageProjection) => void;
  onDownload?: (message: MessageProjection) => void;
};

/** How close to the far end counts as "asking for more" (in pixels). */
const NEAR_END_PX = 240;

export const MessageList = ({
  messages,
  lang,
  t,
  now,
  hasOlder,
  isLoading,
  onLoadOlder,
  onRetry,
  onDownload,
}: MessageListProps) => {
  const theme = useTheme();
  const asking = useRef(false);

  /**
   * Reading `scrollTop` is allowed; writing it is not. In a column-reverse
   * container the offset grows *away* from the bottom, so nearing the far end
   * means nearing the oldest message — which is exactly when the next page is
   * wanted.
   */
  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!hasOlder || isLoading) return;

      const node = event.currentTarget;
      const distanceFromOldest =
        node.scrollHeight - node.clientHeight - Math.abs(node.scrollTop);

      if (distanceFromOldest > NEAR_END_PX) {
        asking.current = false;

        return;
      }

      // Once per approach, not once per scroll event.
      if (asking.current) return;

      asking.current = true;
      onLoadOlder();
    },
    [hasOlder, isLoading, onLoadOlder],
  );

  /**
   * A separator belongs *above* the last message of a day. In a newest-first
   * array rendered into a column-reverse container, "above" is the row after
   * it — so the marker attaches to the message whose successor is on an earlier
   * day, and the oldest message always carries one.
   */
  const separators = useMemo(() => {
    const marks = new Map<string, string>();

    messages.forEach((message, index) => {
      const stamp = message.waTimestamp ?? message.createdAt;
      const next = messages[index + 1];
      const nextStamp = next === undefined ? null : (next.waTimestamp ?? next.createdAt);

      if (next === undefined || dayKey(stamp) !== dayKey(nextStamp)) {
        marks.set(message.id, daySeparator(stamp, now, lang, t));
      }
    });

    return marks;
  }, [messages, now, lang, t]);

  return (
    <div
      className="wa-message-list"
      onScroll={onScroll}
      style={{
        display: 'flex',
        flexDirection: 'column-reverse',
        overflowY: 'auto',
        overflowX: 'hidden',
        gap: theme.spacing[1],
        flex: '1 1 auto',
        minHeight: 0,
        padding: theme.spacing[2],
      }}
    >
      {messages.length === 0 ? (
        <div
          style={{
            color: theme.font.color.tertiary,
            fontSize: theme.font.size.sm,
            textAlign: 'center',
            padding: theme.spacing[4],
          }}
        >
          {t('chat.empty')}
        </div>
      ) : null}

      {messages.map((message) => {
        const separator = separators.get(message.id);

        return (
          <div
            key={message.id}
            style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}
          >
            <MessageBubble
              message={message}
              lang={lang}
              t={t}
              onRetry={onRetry}
              onDownload={onDownload}
            />
            {separator === undefined ? null : (
              <div
                style={{
                  alignSelf: 'center',
                  fontSize: theme.font.size.xxs,
                  color: theme.font.color.tertiary,
                  background: theme.background.transparent.light,
                  borderRadius: theme.border.radius.pill,
                  padding: `0 ${theme.spacing[2]}`,
                  order: -1,
                }}
              >
                {separator}
              </div>
            )}
          </div>
        );
      })}

      {/*
        Last in the array, so it renders at the visual *top* — where a reader
        looking for older messages is already looking. The scroll handler above
        presses it for them; this is for anyone whose pointer does not scroll.
      */}
      {hasOlder ? (
        <button
          type="button"
          onClick={onLoadOlder}
          disabled={isLoading}
          aria-label={t('chat.loadOlder')}
          style={{
            alignSelf: 'center',
            border: `1px solid ${theme.border.color.medium}`,
            background: 'transparent',
            borderRadius: theme.border.radius.pill,
            color: theme.font.color.secondary,
            cursor: isLoading ? 'default' : 'pointer',
            fontSize: theme.font.size.xs,
            padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
          }}
        >
          {t('chat.loadOlder')}
        </button>
      ) : null}
    </div>
  );
};
