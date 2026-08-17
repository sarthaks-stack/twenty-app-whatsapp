import type { MessageContentProjection } from '../../domain/feed/content';
import type { MessageProjection } from '../../domain/feed/projection';
import type { QuoteProjection } from '../../domain/feed/quote';

/**
 * The bubble that exists before the server has one (specs/08 §3, D-6).
 *
 * `optimisticMessage(body, templateName)` was enough while a rep could send two
 * things. With eight it becomes a lie: a location send drew an empty bubble, an
 * interactive message drew nothing at all, and a media send had no way to say
 * "uploading". The factory takes the *content* instead, so an optimistic bubble
 * goes through the same renderer as the delivered one and the two cannot look
 * different.
 *
 * Everything here is reconciled by `clientToken`, exactly as before: the
 * server's row replaces the local one rather than appearing beside it
 * (`mergeMessages`).
 */

export type OptimisticInput = {
  threadId: string;
  clientToken: string;
  content: MessageContentProjection;
  /** The strip the delivered bubble will also render, shown immediately. */
  quote?: QuoteProjection | null;
  /** The stored `messageType`, so a settled bubble does not change shape. */
  type: string;
  /** What the inbox preview and the retry action read. */
  body?: string | null;
  templateName?: string | null;
};

export const optimisticMessage = ({
  threadId,
  clientToken,
  content,
  quote = null,
  type,
  body = null,
  templateName = null,
}: OptimisticInput): MessageProjection => ({
  id: `local-${clientToken}`,
  wamid: null,
  direction: 'OUTBOUND',
  type,
  status: 'QUEUED',
  body,
  waTimestamp: null,
  createdAt: new Date().toISOString(),
  statusTimestamps: {},
  errorCode: null,
  errorDetail: null,
  retryCount: 0,
  isRetryable: false,
  lane: 'INTERACTIVE',
  sourceKind: 'AGENT',
  templateName,
  templateLanguage: null,
  templateCategory: null,
  contextWamid: quote?.wamid ?? null,
  reactionTargetWamid: null,
  media: null,
  reactions: [],
  content,
  quote,
  payload: null,
  clientToken,
  sentById: null,
  /**
   * Left null even though the sender is by definition the rep looking at the
   * screen. Their own name under their own message, for the two seconds before
   * the server's row replaces it, is noise — and the delivered bubble carries
   * it, so nothing is lost.
   */
  sentByLabel: null,
  threadId,
});

/**
 * The optimistic bubble for each of the composer's sends.
 *
 * A `content` and a `type` for every kind, in one place, because the pairing is
 * exactly what a renderer registry keys off and getting it wrong shows a
 * document card over a location for as long as the send takes.
 */
export const optimisticText = (
  base: Omit<OptimisticInput, 'content' | 'type' | 'body'>,
  body: string,
): MessageProjection =>
  optimisticMessage({ ...base, type: 'TEXT', body, content: { kind: 'text', body } });

export const optimisticTemplate = (
  base: Omit<OptimisticInput, 'content' | 'type'>,
  template: { name: string | null; language: string | null; category: string | null },
): MessageProjection =>
  optimisticMessage({
    ...base,
    type: 'TEMPLATE',
    templateName: template.name,
    content: {
      kind: 'template',
      template: { ...template, body: base.body ?? null },
    },
  });

export const optimisticLocation = (
  base: Omit<OptimisticInput, 'content' | 'type'>,
  location: {
    name: string | null;
    address: string | null;
    latitude: number;
    longitude: number;
  },
): MessageProjection =>
  optimisticMessage({
    ...base,
    type: 'LOCATION',
    body: location.name ?? location.address,
    content: { kind: 'location', ...location },
  });

export const optimisticInteractive = (
  base: Omit<OptimisticInput, 'content' | 'type'>,
  interactive: Extract<MessageContentProjection, { kind: 'interactive' }>['interactive'],
): MessageProjection =>
  optimisticMessage({
    ...base,
    type: 'INTERACTIVE',
    body:
      interactive.kind === 'other' ? interactive.body : (interactive.body ?? null),
    content: { kind: 'interactive', interactive },
  });

export const optimisticContacts = (
  base: Omit<OptimisticInput, 'content' | 'type'>,
  contacts: Extract<MessageContentProjection, { kind: 'contacts' }>['contacts'],
): MessageProjection =>
  optimisticMessage({
    ...base,
    type: 'CONTACTS',
    body: contacts[0]?.formattedName ?? contacts[0]?.firstName ?? null,
    content: { kind: 'contacts', contacts },
  });

const MEDIA_TYPE: Record<string, string> = {
  image: 'IMAGE',
  video: 'VIDEO',
  audio: 'AUDIO',
  document: 'DOCUMENT',
  sticker: 'STICKER',
};

/**
 * An attachment already uploaded to Twenty, shown before Meta has it.
 *
 * The preview is the *stored* file's own URL — the same one the delivered
 * bubble will render — so the image does not visibly reload when the server row
 * arrives. There is no upload progress to show: by the time this is called the
 * bytes are already in Twenty, and the remaining wait is Meta's, which reports
 * nothing until it either accepts or fails.
 */
export const optimisticMedia = (
  base: Omit<OptimisticInput, 'content' | 'type'>,
  media: {
    mediaKind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
    url: string | null;
    fileName: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    caption: string | null;
    isVoice?: boolean;
    /**
     * The send spec, carried on the bubble so that a refusal the rep can fix —
     * an address the file store would not serve — is retryable without them
     * finding the file again. The delivered row carries the same thing in its
     * `payload` column; this is the local stand-in for the seconds before it
     * exists (D-58).
     */
    spec?: Record<string, unknown> | null;
  },
): MessageProjection => {
  const type = MEDIA_TYPE[media.mediaKind] ?? 'DOCUMENT';

  const projection = {
    kind: type,
    mimeType: media.mimeType,
    fileName: media.fileName,
    sizeBytes: media.sizeBytes,
    url: media.url,
    deferred: false,
    downloadFailed: false,
    isVoice: media.isVoice === true,
    isAnimated: false,
    durationSeconds: null,
    width: null,
    height: null,
  };

  const content: MessageContentProjection =
    media.mediaKind === 'image'
      ? { kind: 'image', media: projection, caption: media.caption }
      : media.mediaKind === 'video'
        ? { kind: 'video', media: projection, caption: media.caption }
        : media.mediaKind === 'audio'
          ? { kind: 'audio', media: projection, isVoice: media.isVoice === true }
          : media.mediaKind === 'sticker'
            ? { kind: 'sticker', media: projection }
            : { kind: 'document', media: projection, caption: media.caption };

  return {
    ...optimisticMessage({ ...base, type, body: media.caption, content }),
    media: projection,
    payload: media.spec ?? null,
  };
};
