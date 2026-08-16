import { useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { MessageProjection } from '../../domain/feed/projection';
import { errorCopy, type Lang, type Translate } from '../common/copy';
import { clockTime, fileSize } from '../common/format';

/**
 * One message (specs/08 §3.2, FR-UI-1).
 *
 * Nothing here decides anything. The status a bubble draws, whether a retry is
 * offered, whether media was deferred — all of it was decided on the server and
 * arrived on the projection. A component that re-derived "is this retryable"
 * would eventually disagree with the route that handles the retry, and the
 * rep would meet a button that does nothing.
 *
 * Status is never conveyed by colour alone: every tick carries an `aria-label`
 * and a failure carries an icon *and* a sentence.
 */

export type MessageBubbleProps = {
  message: MessageProjection;
  lang: Lang;
  t: Translate;
  onRetry?: (message: MessageProjection) => void;
  onDownload?: (message: MessageProjection) => void;
};

/** Text, because a tick is a glyph and a glyph is not an accessible name. */
const TICKS: Record<string, string> = {
  QUEUED: '🕓',
  ACCEPTED: '✓',
  SENT: '✓',
  DELIVERED: '✓✓',
  READ: '✓✓',
  PLAYED: '✓✓',
  FAILED: '⚠',
};

const isBlue = (status: string | null): boolean =>
  status === 'READ' || status === 'PLAYED';

export const MessageBubble = ({
  message,
  lang,
  t,
  onRetry,
  onDownload,
}: MessageBubbleProps) => {
  const theme = useTheme();
  const [showDetails, setShowDetails] = useState(false);

  const outbound = message.direction === 'OUTBOUND';
  const failed = message.status === 'FAILED';
  const media = message.media;

  const bubble: React.CSSProperties = {
    alignSelf: outbound ? 'flex-end' : 'flex-start',
    maxWidth: '80%',
    minWidth: '96px',
    padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
    borderRadius: theme.border.radius.md,
    background: outbound
      ? theme.background.transparent.blue
      : theme.background.transparent.light,
    border: failed ? `1px solid ${theme.border.color.danger}` : '1px solid transparent',
    fontSize: theme.font.size.sm,
    color: theme.font.color.primary,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing[1],
    wordBreak: 'break-word',
  };

  const meta: React.CSSProperties = {
    fontSize: theme.font.size.xxs,
    color: theme.font.color.tertiary,
    display: 'flex',
    gap: theme.spacing[1],
    alignItems: 'center',
    alignSelf: 'flex-end',
  };

  const chip: React.CSSProperties = {
    fontSize: theme.font.size.xxs,
    color: theme.font.color.secondary,
    background: theme.background.transparent.light,
    borderRadius: theme.border.radius.sm,
    padding: `0 ${theme.spacing[1]}`,
    alignSelf: 'flex-start',
  };

  const renderMedia = () => {
    if (media === null) return null;

    /**
     * D-8: a file over the ceiling was never downloaded. The bubble offers the
     * click rather than pretending the video is missing.
     */
    if (media.deferred || media.url === null) {
      return (
        <button
          type="button"
          className="wa-bubble-download"
          onClick={() => onDownload?.(message)}
          aria-label={t('chat.download', { size: fileSize(media.sizeBytes) })}
          style={{
            border: `1px solid ${theme.border.color.medium}`,
            background: 'transparent',
            borderRadius: theme.border.radius.sm,
            padding: theme.spacing[1],
            color: theme.font.color.secondary,
            cursor: 'pointer',
            fontSize: theme.font.size.xs,
          }}
        >
          {media.downloadFailed ? `⚠ ${t('error.MEDIA_UNAVAILABLE')}` : null}
          {media.downloadFailed
            ? null
            : t('chat.download', { size: fileSize(media.sizeBytes) })}
        </button>
      );
    }

    const kind = media.kind ?? '';

    if (kind === 'IMAGE' || kind === 'STICKER') {
      return (
        <img
          src={media.url}
          alt={media.fileName ?? kind}
          // No IntersectionObserver anywhere near this: the attribute is the
          // whole implementation, and the sandbox throws on the alternative.
          loading="lazy"
          style={{
            maxWidth: '100%',
            maxHeight: kind === 'STICKER' ? '120px' : '320px',
            borderRadius: theme.border.radius.sm,
          }}
        />
      );
    }

    if (kind === 'AUDIO') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
          <span style={{ fontSize: theme.font.size.xxs, color: theme.font.color.tertiary }}>
            {t('chat.voiceNote')}
          </span>
          <audio controls src={media.url} style={{ maxWidth: '100%' }} />
        </div>
      );
    }

    if (kind === 'VIDEO') {
      return (
        <video
          controls
          preload="metadata"
          src={media.url}
          style={{ maxWidth: '100%', maxHeight: '320px', borderRadius: theme.border.radius.sm }}
        />
      );
    }

    return (
      <a
        href={media.url}
        target="_blank"
        rel="noreferrer"
        style={{ color: theme.font.color.secondary, fontSize: theme.font.size.xs }}
      >
        📎 {media.fileName ?? 'ficheiro'} · {fileSize(media.sizeBytes)}
      </a>
    );
  };

  const unsupported =
    message.type === 'SYSTEM' ||
    (message.body === null && media === null && message.type !== 'LOCATION');

  return (
    <div className="wa-bubble" style={bubble}>
      {message.templateName === null ? null : (
        <span style={chip}>
          {t('chat.template')}: {message.templateName}
        </span>
      )}

      {message.lane === 'CAMPAIGN' ? <span style={chip}>{t('chat.campaign')}</span> : null}

      {/*
        The quoted message, as an inset strip. Only the id is on the wire — the
        server does not join the quoted row, and rendering a stub beats a second
        round trip per bubble (FR-OUT-3).
      */}
      {message.contextWamid === null ? null : (
        <div
          style={{
            borderLeft: `2px solid ${theme.border.color.medium}`,
            paddingLeft: theme.spacing[1],
            fontSize: theme.font.size.xxs,
            color: theme.font.color.tertiary,
          }}
        >
          ↪
        </div>
      )}

      {renderMedia()}

      {message.body === null ? null : (
        <span style={{ whiteSpace: 'pre-wrap' }}>{message.body}</span>
      )}

      {unsupported ? (
        <span
          style={{
            fontStyle: 'italic',
            color: theme.font.color.tertiary,
            fontSize: theme.font.size.xs,
          }}
        >
          {t('chat.unsupported')}
        </span>
      ) : null}

      {message.reactions.length === 0 ? null : (
        <div style={{ display: 'flex', gap: theme.spacing[1] }}>
          {message.reactions.map((reaction) => (
            <span key={`${reaction.waId}-${reaction.emoji}`} style={chip}>
              {reaction.emoji}
            </span>
          ))}
        </div>
      )}

      {failed ? (
        <div
          style={{
            fontSize: theme.font.size.xxs,
            color: theme.font.color.danger,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing[1],
          }}
        >
          <span>⚠ {errorCopy(t, message.errorCode, message.errorDetail)}</span>
          {message.isRetryable && onRetry !== undefined ? (
            <button
              type="button"
              onClick={() => onRetry(message)}
              aria-label={t('chat.retry')}
              style={{
                alignSelf: 'flex-start',
                border: `1px solid ${theme.border.color.danger}`,
                background: 'transparent',
                borderRadius: theme.border.radius.sm,
                color: theme.font.color.danger,
                cursor: 'pointer',
                fontSize: theme.font.size.xxs,
                padding: `0 ${theme.spacing[1]}`,
              }}
            >
              {t('chat.retry')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div style={meta}>
        <span>{clockTime(message.waTimestamp ?? message.createdAt, lang)}</span>
        {outbound ? (
          <span
            aria-label={t(`status.${message.status ?? 'QUEUED'}`)}
            title={t(`status.${message.status ?? 'QUEUED'}`)}
            style={{
              color: isBlue(message.status)
                ? theme.color.blue
                : failed
                  ? theme.font.color.danger
                  : theme.font.color.tertiary,
            }}
          >
            {TICKS[message.status ?? 'QUEUED'] ?? ''}
          </span>
        ) : null}
        {unsupported || message.payload === null ? null : (
          <button
            type="button"
            onClick={() => setShowDetails((current) => !current)}
            aria-label={t('chat.details')}
            style={{
              border: 'none',
              background: 'transparent',
              color: theme.font.color.tertiary,
              cursor: 'pointer',
              fontSize: theme.font.size.xxs,
              padding: 0,
            }}
          >
            ⋯
          </button>
        )}
      </div>

      {showDetails ? (
        <pre
          style={{
            fontSize: theme.font.size.xxs,
            color: theme.font.color.tertiary,
            overflowX: 'auto',
            margin: 0,
            maxWidth: '100%',
          }}
        >
          {JSON.stringify(message.payload, null, 1)}
        </pre>
      ) : null}
    </div>
  );
};
