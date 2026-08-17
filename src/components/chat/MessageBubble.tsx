import { useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { MessageProjection } from '../../domain/feed/projection';
import { errorCopy, type Lang, type Translate } from '../common/copy';
import { clockTime, fileSize } from '../common/format';
import { DeliveryTicks, Glyph } from '../common/icons';
import { messageDetails } from './details';

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
 *
 * **Nothing in a bubble is `xxs`.** That size measured ~8px in the rendered
 * page — a timestamp, a template name and a failure reason were all set in it,
 * and the failure reason is the single most important sentence in the whole
 * conversation. The metadata line is `xs`, the content is `sm`, and every
 * button in here clears a 24px target.
 */

export type MessageBubbleProps = {
  message: MessageProjection;
  lang: Lang;
  t: Translate;
  onRetry?: (message: MessageProjection) => void;
  onDownload?: (message: MessageProjection) => void;
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
  const details = messageDetails(message);

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
    fontSize: theme.font.size.xs,
    color: theme.font.color.tertiary,
    display: 'flex',
    gap: theme.spacing[1],
    alignItems: 'center',
    alignSelf: 'flex-end',
  };

  const chip: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing[1],
    fontSize: theme.font.size.xs,
    color: theme.font.color.secondary,
    background: theme.background.transparent.light,
    borderRadius: theme.border.radius.sm,
    padding: `${theme.spacing[0.5]} ${theme.spacing[1]}`,
    alignSelf: 'flex-start',
  };

  /**
   * Every button in a bubble, at one size.
   *
   * 24px is the floor rather than the target: these sit inside a message, next
   * to text, and a 40px button would own the bubble. What they must not be is
   * the 8px-type, zero-padding hit areas the review measured — "Repetir" was a
   * link-shaped thing a quarter the height of a fingertip.
   */
  const action: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing[1],
    minHeight: '24px',
    borderRadius: theme.border.radius.sm,
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: theme.font.family,
    fontSize: theme.font.size.xs,
    padding: `0 ${theme.spacing[1]}`,
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
            ...action,
            alignSelf: 'flex-start',
            minHeight: '28px',
            border: `1px solid ${
              media.downloadFailed ? theme.border.color.danger : theme.border.color.medium
            }`,
            color: media.downloadFailed
              ? theme.font.color.danger
              : theme.font.color.secondary,
            padding: `0 ${theme.spacing[2]}`,
          }}
        >
          <Glyph name={media.downloadFailed ? 'warning' : 'download'} />
          {media.downloadFailed
            ? t('error.MEDIA_UNAVAILABLE')
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
          <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
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
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.spacing[1],
          minHeight: '24px',
          color: theme.font.color.secondary,
          fontSize: theme.font.size.sm,
        }}
      >
        <Glyph name="attachment" />
        {media.fileName ?? t('chat.file')} · {fileSize(media.sizeBytes)}
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
          <Glyph name="template" />
          {t('chat.template')}: {message.templateName}
        </span>
      )}

      {message.lane === 'CAMPAIGN' ? (
        <span style={chip}>
          <Glyph name="campaign_replies" />
          {t('chat.campaign')}
        </span>
      ) : null}

      {/*
        The quoted message, as an inset strip. Only the id is on the wire — the
        server does not join the quoted row, and rendering a stub beats a second
        round trip per bubble (FR-OUT-3).
      */}
      {message.contextWamid === null ? null : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            borderLeft: `2px solid ${theme.border.color.medium}`,
            paddingLeft: theme.spacing[1],
            gap: theme.spacing[1],
            color: theme.font.color.tertiary,
            fontSize: theme.font.size.xs,
          }}
        >
          <Glyph name="replies" />
          {t('chat.quoted')}
        </div>
      )}

      {renderMedia()}

      {/*
        A document with no caption is stored with its filename as the body
        (specs/03: "documents caption to their filename"), which is the right
        thing for a preview line in the inbox and the wrong thing here — the
        link above already says it, so printing it again reads as a bug.
      */}
      {message.body === null || message.body === media?.fileName ? null : (
        <span style={{ whiteSpace: 'pre-wrap' }}>{message.body}</span>
      )}

      {unsupported ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            fontStyle: 'italic',
            color: theme.font.color.tertiary,
            fontSize: theme.font.size.sm,
          }}
        >
          <Glyph name="consentUnknown" />
          {t('chat.unsupported')}
        </span>
      ) : null}

      {message.reactions.length === 0 ? null : (
        <div style={{ display: 'flex', gap: theme.spacing[1] }}>
          {/*
            The one place an emoji belongs: it is not decoration the app chose,
            it is what the customer pressed.
          */}
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
            fontSize: theme.font.size.xs,
            color: theme.font.color.danger,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing[1],
          }}
        >
          <span style={{ display: 'flex', alignItems: 'flex-start', gap: theme.spacing[1] }}>
            <Glyph name="warning" />
            {errorCopy(t, message.errorCode, message.errorDetail)}
          </span>
          {message.isRetryable && onRetry !== undefined ? (
            <button
              type="button"
              onClick={() => onRetry(message)}
              aria-label={t('chat.retry')}
              style={{
                ...action,
                alignSelf: 'flex-start',
                minHeight: '28px',
                border: `1px solid ${theme.border.color.danger}`,
                color: theme.font.color.danger,
                padding: `0 ${theme.spacing[2]}`,
              }}
            >
              <Glyph name="retry" />
              {t('chat.retry')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div style={meta}>
        <span>{clockTime(message.waTimestamp ?? message.createdAt, lang)}</span>
        {outbound ? (
          <span
            role="img"
            aria-label={t(`status.${message.status ?? 'QUEUED'}`)}
            title={t(`status.${message.status ?? 'QUEUED'}`)}
            style={{ display: 'inline-flex', alignItems: 'center' }}
          >
            <DeliveryTicks
              status={message.status}
              color={
                isBlue(message.status)
                  ? theme.color.blue
                  : failed
                    ? theme.font.color.danger
                    : theme.font.color.tertiary
              }
            />
          </span>
        ) : null}
        {/*
          The button exists only when there is something to show. It used to
          appear for any message with a payload, which is nearly all of them,
          and answered with the raw webhook object.
        */}
        {details.length === 0 ? null : (
          <button
            type="button"
            onClick={() => setShowDetails((current) => !current)}
            aria-expanded={showDetails}
            aria-label={t(showDetails ? 'chat.detailsHide' : 'chat.details')}
            title={t(showDetails ? 'chat.detailsHide' : 'chat.details')}
            style={{
              ...action,
              minWidth: '24px',
              justifyContent: 'center',
              border: 'none',
              color: theme.font.color.tertiary,
            }}
          >
            <Glyph name="more" />
          </button>
        )}
      </div>

      {showDetails && details.length > 0 ? (
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: `${theme.spacing[0.5]} ${theme.spacing[2]}`,
            margin: 0,
            fontSize: theme.font.size.xs,
          }}
        >
          {details.map((detail, index) => (
            <ContiguousRow
              key={`${detail.key}-${index}`}
              label={t(detail.key)}
              value={detail.value}
            />
          ))}
        </dl>
      ) : null}
    </div>
  );
};

/**
 * One `dt`/`dd` pair. A fragment rather than a wrapper element, so the grid
 * above lays the label and the value into its own two columns instead of
 * receiving one opaque child per row.
 */
const ContiguousRow = ({ label, value }: { label: string; value: string }) => {
  const theme = useTheme();

  return (
    <>
      <dt style={{ color: theme.font.color.tertiary }}>{label}</dt>
      <dd style={{ margin: 0, color: theme.font.color.secondary, wordBreak: 'break-word' }}>
        {value}
      </dd>
    </>
  );
};
