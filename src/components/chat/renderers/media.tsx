import { useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import { documentFamily, type MediaProjection } from '../../../domain/feed/media';
import type { Translate } from '../../common/copy';
import { duration as formatDuration, fileSize } from '../../common/format';
import { Glyph, type IconName } from '../../common/icons';
import { CardAction, ContentCard } from './primitives';

/**
 * The five media cards (spec §"Rich message renderer registry").
 *
 * What changed is not that these types render — they did — but that each now
 * has a *shape a reader recognises before reading it*. An MP3 was a link, a
 * voice note was a bare `<audio>` element, and a 9:16 video filled the pane.
 * The rules below are the ones the spec fixes:
 *
 * - Media reaches ~420 px, never the full lane, and portrait video is capped by
 *   height so it cannot dominate the transcript.
 * - Native `<audio>`/`<video>` controls, always. A custom player calls
 *   `element.play()` through a ref, and a ref method call throws in this
 *   sandbox — the safest player is the browser's own.
 * - A voice message and an audio file are different cards, because they are
 *   different things: one is a turn in the conversation, the other is an
 *   attachment.
 * - `loading="lazy"` is the whole of the lazy-loading implementation.
 *   `IntersectionObserver` is unavailable here, and the attribute needs none.
 */

export const MEDIA_MAX_WIDTH = 420;
const MEDIA_MAX_HEIGHT = 320;
const STICKER_MAX = 128;

export type MediaRendererProps = {
  media: MediaProjection | null;
  caption?: string | null;
  t: Translate;
  onDownload?: () => void;
};

/**
 * D-8: a file over the ceiling was never downloaded, and a file whose download
 * failed has a reason worth reading. Both states offer the action rather than
 * pretending the media is missing.
 */
const PendingMedia = ({
  media,
  t,
  onDownload,
}: {
  media: MediaProjection;
  t: Translate;
  onDownload?: () => void;
}) => {
  const theme = useTheme();
  const failed = media.downloadFailed;

  return (
    <button
      type="button"
      className="wa-thread-media-pending"
      onClick={onDownload}
      aria-label={t('chat.download', { size: fileSize(media.sizeBytes) })}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.spacing[1],
        alignSelf: 'flex-start',
        minHeight: '32px',
        border: `1px solid ${failed ? theme.border.color.danger : theme.border.color.medium}`,
        borderRadius: theme.border.radius.sm,
        background: 'transparent',
        color: failed ? theme.font.color.danger : theme.font.color.secondary,
        cursor: 'pointer',
        fontFamily: theme.font.family,
        fontSize: theme.font.size.sm,
        padding: `0 ${theme.spacing[2]}`,
      }}
    >
      <Glyph name={failed ? 'warning' : 'download'} />
      {failed
        ? t('error.MEDIA_UNAVAILABLE')
        : t('chat.download', { size: fileSize(media.sizeBytes) })}
    </button>
  );
};

const Caption = ({ text }: { text: string | null | undefined }) => {
  const theme = useTheme();

  if (text === null || text === undefined || text.length === 0) return null;

  return (
    <span
      style={{
        whiteSpace: 'pre-wrap',
        fontSize: theme.font.size.sm,
        color: theme.font.color.primary,
        wordBreak: 'break-word',
      }}
    >
      {text}
    </span>
  );
};

export const ImageContent = ({ media, caption, t, onDownload }: MediaRendererProps) => {
  const theme = useTheme();
  const [failed, setFailed] = useState(false);

  if (media === null) return null;
  if (media.deferred || media.url === null) {
    return <PendingMedia media={media} t={t} onDownload={onDownload} />;
  }

  /**
   * A signed URL that has expired renders as a broken-image glyph and no
   * explanation. `onError` is one of the few DOM events the sandbox does
   * forward, so the failure becomes a sentence and a download instead.
   */
  if (failed) {
    return (
      <ContentCard
        icon="warning"
        title={t('chat.imageFailed')}
        subtitle={media.fileName}
        action={
          <CardAction icon="download" label={t('chat.action.download')} href={media.url} />
        }
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
      <a
        href={media.url}
        target="_blank"
        rel="noreferrer"
        aria-label={t('chat.action.openImage')}
        style={{ display: 'inline-flex', maxWidth: '100%' }}
      >
        <img
          src={media.url}
          alt={caption ?? media.fileName ?? t('chat.type.IMAGE')}
          loading="lazy"
          onError={() => setFailed(true)}
          style={{
            maxWidth: `${MEDIA_MAX_WIDTH}px`,
            width: '100%',
            maxHeight: `${MEDIA_MAX_HEIGHT}px`,
            objectFit: 'cover',
            borderRadius: theme.border.radius.sm,
            background: theme.background.transparent.light,
            display: 'block',
          }}
        />
      </a>
      <Caption text={caption} />
    </div>
  );
};

/**
 * A sticker has no bubble.
 *
 * Drawing the ordinary background behind a transparent PNG puts a grey box
 * around something designed to sit on the conversation — see `MessageShell`,
 * which drops its own chrome for this content kind.
 */
export const StickerContent = ({ media, t, onDownload }: MediaRendererProps) => {
  if (media === null) return null;
  if (media.deferred || media.url === null) {
    return <PendingMedia media={media} t={t} onDownload={onDownload} />;
  }

  return (
    <img
      src={media.url}
      alt={t('chat.type.STICKER')}
      loading="lazy"
      style={{
        maxWidth: `${STICKER_MAX}px`,
        maxHeight: `${STICKER_MAX}px`,
        display: 'block',
      }}
    />
  );
};

export const VideoContent = ({ media, caption, t, onDownload }: MediaRendererProps) => {
  const theme = useTheme();

  if (media === null) return null;
  if (media.deferred || media.url === null) {
    return <PendingMedia media={media} t={t} onDownload={onDownload} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
      <video
        controls
        preload="metadata"
        src={media.url}
        style={{
          maxWidth: `${MEDIA_MAX_WIDTH}px`,
          width: '100%',
          /**
           * Height-capped, not just width-capped. A 9:16 clip constrained only
           * by width is 745 px tall in a 420 px lane and pushes the rest of the
           * conversation off the screen.
           */
          maxHeight: `${MEDIA_MAX_HEIGHT}px`,
          borderRadius: theme.border.radius.sm,
          background: theme.background.transparent.strong,
          display: 'block',
        }}
      />
      <Caption text={caption} />
    </div>
  );
};

/**
 * A voice note: a turn in the conversation, labelled as one.
 *
 * The duration is shown beside the label because Meta sends it and the browser
 * only learns it after fetching metadata — so a card that waited for the
 * element would say nothing at all for the first second.
 */
export const VoiceContent = ({ media, t, onDownload }: MediaRendererProps) => {
  if (media === null) return null;
  if (media.deferred || media.url === null) {
    return <PendingMedia media={media} t={t} onDownload={onDownload} />;
  }

  return (
    <ContentCard
      icon="voice"
      title={t('chat.voiceMessage')}
      meta={formatDuration(media.durationSeconds) || null}
    >
      <audio controls preload="metadata" src={media.url} style={{ width: '100%' }} />
    </ContentCard>
  );
};

/**
 * An audio *file*: an attachment that happens to be playable.
 *
 * Told apart from a voice note by the stored `voice` flag, which is why the
 * projection carries it — an MP3 sent from the document picker arrives as
 * `type: document` with an audio MIME type, and nothing about the bytes says
 * which of the two it is.
 */
export const AudioFileContent = ({ media, t, onDownload }: MediaRendererProps) => {
  if (media === null) return null;
  if (media.deferred || media.url === null) {
    return <PendingMedia media={media} t={t} onDownload={onDownload} />;
  }

  const meta = [formatDuration(media.durationSeconds), fileSize(media.sizeBytes)]
    .filter((part) => part.length > 0)
    .join(' · ');

  return (
    <ContentCard
      icon="audio"
      title={media.fileName ?? t('chat.audioFile')}
      subtitle={media.fileName === null ? null : t('chat.audioFile')}
      meta={meta.length === 0 ? null : meta}
      action={
        <CardAction icon="download" label={t('chat.action.download')} href={media.url} />
      }
    >
      <audio controls preload="metadata" src={media.url} style={{ width: '100%' }} />
    </ContentCard>
  );
};

const FAMILY_ICON: Record<ReturnType<typeof documentFamily>, IconName> = {
  pdf: 'pdf',
  sheet: 'sheet',
  doc: 'doc',
  slides: 'slides',
  archive: 'zip',
  code: 'code',
  file: 'file',
};

export const DocumentContent = ({ media, caption, t, onDownload }: MediaRendererProps) => {
  const theme = useTheme();

  if (media === null) return null;
  if (media.deferred || media.url === null) {
    return <PendingMedia media={media} t={t} onDownload={onDownload} />;
  }

  const family = documentFamily(media);
  const meta = [family === 'file' ? '' : family.toUpperCase(), fileSize(media.sizeBytes)]
    .filter((part) => part.length > 0)
    .join(' · ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
      <ContentCard
        icon={FAMILY_ICON[family]}
        title={media.fileName ?? t('chat.type.DOCUMENT')}
        meta={meta.length === 0 ? null : meta}
        action={
          <CardAction
            icon="download"
            label={t('chat.action.openDocument')}
            href={media.url}
          />
        }
      />
      <Caption text={caption} />
    </div>
  );
};
