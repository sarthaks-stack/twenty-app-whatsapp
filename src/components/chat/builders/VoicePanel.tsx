import { useCallback, useEffect, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { useTheme } from 'twenty-ui/theme-constants';

import type { Translate } from '../../common/copy';
import { duration as formatDuration } from '../../common/format';
import { Glyph } from '../../common/icons';

/**
 * Recording a voice message (spec §"What can be delivered now", item 3).
 *
 * This is the one attachment path the sandbox genuinely allows. A file input
 * exposes metadata and not bytes and `FileReader` is unavailable, so a device
 * picker cannot feed the media pipeline — but `MediaRecorder` *produces* the
 * bytes inside the page, so there is nothing to read from disk.
 *
 * The rest is deliberately unglamorous:
 *
 * - **`Blob` → base64 → `POST /whatsapp/upload` → `sendMedia`.** The page has
 *   no token for Twenty's upload mutation, so an authenticated route does the
 *   storing (see `wa-upload-route`).
 * - **Every track is stopped when the panel closes.** A `getUserMedia` stream
 *   left running keeps the browser's recording indicator lit and the microphone
 *   open — in a CRM tab that stays open all day, indefinitely.
 * - **Permission denial is a sentence, not a dead button.** The two failures a
 *   rep can actually act on — no API, or no permission — say which one happened.
 * - **The `<audio>` review step uses native controls.** A custom player would
 *   call `element.play()` through a ref, and a ref method call throws here.
 */

export type VoicePanelProps = {
  t: Translate;
  isSending: boolean;
  /**
   * No `onCancel`: the panel's frame owns closing it, and unmounting is what
   * stops the microphone (see `release`). A second cancel inside the body would
   * be a second way to do the same thing, one of which would eventually forget
   * to release the stream.
   */
  onSend: (input: { fileUrl: string; filePath: string; filename: string }) => void;
};

type Phase = 'idle' | 'recording' | 'review' | 'uploading' | 'unavailable' | 'denied';

/**
 * Only formats Meta accepts as audio.
 *
 * The obvious list would start with `audio/webm;codecs=opus`, which is what
 * Chrome's `MediaRecorder` produces most readily — and WhatsApp does not accept
 * WebM. Recording it anyway and declaring it `audio/ogg` is tempting because
 * the codec inside is the same Opus; it is also a lie about the container, and
 * the failure lands either at Meta's validator or, worse, on the customer's
 * device as audio that will not play.
 *
 * So the recorder is offered only when the browser can produce something
 * sendable, and says plainly that it cannot when it cannot. A voice note that
 * silently arrives broken is a far worse outcome than a button that is honest
 * about being unavailable.
 */
const CANDIDATE_TYPES = [
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/mpeg',
];

const supportedType = (): string | null => {
  const recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;

  if (recorder === undefined) return null;

  return (
    CANDIDATE_TYPES.find((type) => {
      try {
        return recorder.isTypeSupported(type);
      } catch {
        return false;
      }
    }) ?? null
  );
};

/** `audio/ogg;codecs=opus` → `audio/ogg`: Meta validates the base type. */
const declaredType = (recorded: string): string =>
  (recorded.split(';')[0] ?? recorded).trim();

const EXTENSION: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
};

const toBase64 = async (blob: Blob): Promise<string> => {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  /**
   * Chunked, because `String.fromCharCode(...bytes)` on a megabyte of audio
   * spreads a million arguments onto the call stack and throws
   * `RangeError: Maximum call stack size exceeded` — on exactly the recordings
   * long enough to matter.
   */
  let binary = '';

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return btoa(binary);
};

export const VoicePanel = ({ t, isSending, onSend }: VoicePanelProps) => {
  const theme = useTheme();
  const client = useRef(new RestApiClient());
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The one piece of cleanup that must never be skipped. Everything else here
   * is recoverable; a live microphone is not.
   */
  const release = useCallback(() => {
    if (ticker.current !== null) clearInterval(ticker.current);
    ticker.current = null;

    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    recorder.current = null;
  }, []);

  useEffect(() => release, [release]);

  useEffect(
    () => () => {
      if (previewUrl !== null) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const start = async () => {
    const type = supportedType();

    if (type === null || globalThis.navigator?.mediaDevices === undefined) {
      setPhase('unavailable');

      return;
    }

    try {
      const media = await globalThis.navigator.mediaDevices.getUserMedia({ audio: true });

      stream.current = media;
      chunks.current = [];

      const instance = new MediaRecorder(media, { mimeType: type });

      instance.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };

      instance.onstop = () => {
        const recorded = new Blob(chunks.current, { type });

        setBlob(recorded);
        setPreviewUrl(URL.createObjectURL(recorded));
        setPhase('review');
        release();
      };

      recorder.current = instance;
      instance.start();

      setSeconds(0);
      setPhase('recording');
      ticker.current = setInterval(() => setSeconds((current) => current + 1), 1000);
    } catch {
      // Both "the rep said no" and "there is no microphone" land here, and the
      // browser deliberately does not distinguish them. The recoverable one is
      // the likelier one, so that is what the message says.
      setPhase('denied');
      release();
    }
  };

  const stop = () => recorder.current?.stop();

  const discard = () => {
    release();
    setBlob(null);
    setPreviewUrl(null);
    setSeconds(0);
    setError(null);
    setPhase('idle');
  };

  const upload = async () => {
    if (blob === null) return;

    setPhase('uploading');
    setError(null);

    try {
      const contentType = declaredType(blob.type);
      const filename = `voice-${seconds}s.${EXTENSION[contentType] ?? 'ogg'}`;

      const stored = await client.current.post<{ fileUrl?: string; filePath?: string }>(
        '/s/whatsapp/upload',
        {
          filename,
          contentType,
          mediaKind: 'audio',
          data: await toBase64(blob),
        },
      );

      if (typeof stored.filePath !== 'string' && typeof stored.fileUrl !== 'string') {
        throw new Error('upload returned no handle');
      }

      onSend({
        fileUrl: stored.fileUrl ?? '',
        filePath: stored.filePath ?? '',
        filename,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('chat.recordUploadFailed'));
      setPhase('review');
    }
  };

  const primary: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing[1],
    minHeight: '32px',
    border: '1px solid transparent',
    borderRadius: theme.border.radius.sm,
    background: theme.color.blue,
    color: theme.font.color.inverted,
    cursor: 'pointer',
    fontFamily: theme.font.family,
    fontSize: theme.font.size.sm,
    padding: `0 ${theme.spacing[2]}`,
  };

  const quiet: React.CSSProperties = {
    ...primary,
    border: `1px solid ${theme.border.color.medium}`,
    background: 'transparent',
    color: theme.font.color.secondary,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        padding: theme.spacing[2],
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
      }}
    >

      {phase === 'unavailable' || phase === 'denied' ? (
        <span
          role="alert"
          style={{
            display: 'inline-flex',
            alignItems: 'flex-start',
            gap: theme.spacing[1],
            fontSize: theme.font.size.sm,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="warning" />
          {t(phase === 'denied' ? 'chat.recordDenied' : 'chat.recordUnavailable')}
        </span>
      ) : null}

      {phase === 'recording' ? (
        <span
          role="status"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            fontSize: theme.font.size.sm,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="record" />
          {t('chat.recording', { duration: formatDuration(seconds) })}
        </span>
      ) : null}

      {phase === 'review' && previewUrl !== null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
          <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
            {t('chat.recordReview')}
          </span>
          <audio controls src={previewUrl} style={{ width: '100%' }} />
        </div>
      ) : null}

      {phase === 'uploading' ? (
        <span
          role="status"
          style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}
        >
          {t('chat.recordUploading')}
        </span>
      ) : null}

      {error === null ? null : (
        <span
          role="alert"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            fontSize: theme.font.size.xs,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="warning" />
          {error}
        </span>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: theme.spacing[2],
          flexWrap: 'wrap',
        }}
      >
        {phase === 'idle' || phase === 'denied' || phase === 'unavailable' ? (
          <button type="button" onClick={() => void start()} style={primary}>
            <Glyph name="record" size="md" />
            {t('chat.recordStart')}
          </button>
        ) : null}

        {phase === 'recording' ? (
          <button type="button" onClick={stop} style={primary}>
            <Glyph name="stopRecording" size="md" />
            {t('chat.recordStop')}
          </button>
        ) : null}

        {phase === 'review' ? (
          <>
            <button type="button" onClick={discard} style={quiet}>
              {t('chat.recordDiscard')}
            </button>
            <button
              type="button"
              onClick={() => void upload()}
              disabled={isSending}
              style={primary}
            >
              <Glyph name="send" size="md" />
              {t('chat.send')}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
};
