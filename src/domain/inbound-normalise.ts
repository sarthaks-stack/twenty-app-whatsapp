import { MESSAGE_TYPE, type MessageType } from './constants';
import type { MetaMediaPayload, MetaMessage, MetaReferral } from './webhook/types';

/**
 * Meta inbound message → the shape stored on `whatsappMessage` (FR-IN-1,
 * specs/03 §4.1). Pure: the processor does the I/O, this decides the content.
 *
 * The governing rule is FR-IN-1's "stored with a placeholder rather than
 * dropped". The raw message always survives in `payload`, so an unrecognised
 * type is a rendering gap, never data loss — which is why the default branch
 * below is a normal outcome rather than an error path.
 */

export type MediaMeta = {
  mediaId: string | null;
  mimeType: string | null;
  sha256: string | null;
  fileSize: number | null;
  filename: string | null;
  voice: boolean;
  animated: boolean;
  /** Meta's undocumented inlined download URL, when present (specs/03 §8). */
  inlineUrl: string | null;
  /** Derived from the URL's `ext` parameter; ~5 minutes in practice. */
  inlineUrlExpiresAt: Date | null;
  downloadAttempts: number;
};

export type NormalisedInbound = {
  messageType: MessageType;
  body: string | null;
  /**
   * Always an object or null, never a bare array: Twenty types every RAW_JSON
   * column as `Record<string, unknown>`, so a contact card list is stored as
   * `{ contacts: [...] }`.
   */
  payload: Record<string, unknown> | null;
  mediaMeta: MediaMeta | null;
  contextWamid: string | null;
  reactionTargetWamid: string | null;
  referral: MetaReferral | null;
  errorCode: string | null;
  errorDetail: string | null;
  waTimestamp: Date;
  /** Whether `wa-media-worker` has anything to fetch (specs/03 §4 step 9a). */
  isMedia: boolean;
  /** `whatsappThread.lastMessagePreview` — plain text, ≤120 chars. */
  preview: string;
};

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

const PREVIEW_MAX = 120;

/**
 * pt-PT is the market (TRD §1), and the preview is written server-side into a
 * denormalised column, so it cannot be localised at render time. Kept as a
 * table rather than inline strings so adding `en` later is a lookup change and
 * not an archaeology exercise.
 */
export const MEDIA_PREVIEW_LABELS = {
  image: '📷 Imagem',
  video: '🎥 Vídeo',
  audio: '🎵 Áudio',
  voice: '🎤 Mensagem de voz',
  document: '📄 Documento',
  sticker: '🌟 Autocolante',
  location: '📍 Localização',
  contacts: '👤 Contacto',
  unsupported: '⚠️ Mensagem não suportada',
} as const;

const trimToNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();

  return trimmed.length === 0 ? null : trimmed;
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

/**
 * `ext` is decimal epoch seconds. Confirmed against a real delivery: message
 * timestamp 1786809498, `ext` 1786809799 — a 301-second life, half the ~10
 * minutes the spec originally recorded. The narrow validity band rejects a
 * millisecond value or a hex `oe`-style token rather than producing a date in
 * 58000 AD, because an over-long expiry is the dangerous direction: it would
 * make the worker skip the `GET /{media_id}` fallback and download nothing.
 */
export const parseInlineUrlExpiry = (url: string | null | undefined): Date | null => {
  if (typeof url !== 'string' || url.length === 0) return null;

  const match = /[?&]ext=(\d{9,11})(?:&|$)/.exec(url);
  if (match === null) return null;

  const seconds = Number(match[1]);
  // 2001-09-09 … 2286-11-20, i.e. plausible as seconds and implausible as ms.
  if (seconds < 1_000_000_000 || seconds > 9_999_999_999) return null;

  return new Date(seconds * 1000);
};

const mediaMetaFrom = (
  media: MetaMediaPayload | undefined,
  extra: { filename?: string; voice?: boolean; animated?: boolean },
): MediaMeta => {
  const inlineUrl = trimToNull(media?.url);

  return {
    mediaId: trimToNull(media?.id),
    mimeType: trimToNull(media?.mime_type),
    sha256: trimToNull(media?.sha256),
    fileSize: toFiniteNumber(media?.file_size),
    filename: trimToNull(extra.filename),
    voice: extra.voice === true,
    animated: extra.animated === true,
    inlineUrl,
    inlineUrlExpiresAt: parseInlineUrlExpiry(inlineUrl),
    downloadAttempts: 0,
  };
};

/**
 * What the media *actually is*, as distinct from the type Meta labelled it.
 *
 * An audio file sent from the device's document picker arrives as
 * `type: document` with `mime_type: audio/mpeg` (observed 2026-08-15). The
 * stored `messageType` stays faithful to Meta, but every renderer and the
 * thread preview must key off this instead, or a customer who plainly sent
 * audio gets a bare download link (specs/03 §4.1).
 */
export const effectiveMediaKind = (
  meta: MediaMeta | null,
  messageType: MessageType,
): 'image' | 'video' | 'audio' | 'sticker' | 'file' | null => {
  if (meta === null) return null;
  if (messageType === MESSAGE_TYPE.STICKER) return 'sticker';

  const mime = meta.mimeType ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';

  switch (messageType) {
    case MESSAGE_TYPE.IMAGE:
      return 'image';
    case MESSAGE_TYPE.VIDEO:
      return 'video';
    case MESSAGE_TYPE.AUDIO:
      return 'audio';
    default:
      return 'file';
  }
};

export const truncatePreview = (value: string, max = PREVIEW_MAX): string => {
  const collapsed = value.replace(/\s+/g, ' ').trim();

  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
};

const mediaPreview = (meta: MediaMeta, messageType: MessageType, caption: string | null): string => {
  const kind = effectiveMediaKind(meta, messageType);

  const label = ((): string => {
    if (kind === 'audio') {
      return meta.voice ? MEDIA_PREVIEW_LABELS.voice : MEDIA_PREVIEW_LABELS.audio;
    }
    if (kind === 'image') return MEDIA_PREVIEW_LABELS.image;
    if (kind === 'video') return MEDIA_PREVIEW_LABELS.video;
    if (kind === 'sticker') return MEDIA_PREVIEW_LABELS.sticker;

    return MEDIA_PREVIEW_LABELS.document;
  })();

  const detail = caption ?? meta.filename;

  return truncatePreview(detail === null ? label : `${label} · ${detail}`);
};

/** The first contact's display name, from any of the shapes Meta uses. */
const contactName = (contacts: unknown[] | undefined): string | null => {
  const first = contacts?.[0];
  if (first === null || typeof first !== 'object') return null;

  const card = first as { name?: { formatted_name?: string; first_name?: string } };

  return trimToNull(card.name?.formatted_name) ?? trimToNull(card.name?.first_name);
};

export const normaliseInboundMessage = (message: MetaMessage): NormalisedInbound => {
  const type = message.type ?? 'unknown';
  const errorCode = message.errors?.[0]?.code;
  const errorDetail =
    trimToNull(message.errors?.[0]?.error_data?.details) ??
    trimToNull(message.errors?.[0]?.title) ??
    trimToNull(message.errors?.[0]?.message);

  const base = {
    contextWamid: trimToNull(message.context?.id),
    reactionTargetWamid: null as string | null,
    referral: message.referral ?? null,
    errorCode: errorCode === undefined ? null : String(errorCode),
    errorDetail,
    waTimestamp: new Date((toFiniteNumber(message.timestamp) ?? 0) * 1000),
    isMedia: false,
    mediaMeta: null as MediaMeta | null,
  };

  const unsupported = (reason: string): NormalisedInbound => ({
    ...base,
    messageType: MESSAGE_TYPE.UNSUPPORTED,
    body: reason,
    payload: message as Record<string, unknown>,
    preview: truncatePreview(`${MEDIA_PREVIEW_LABELS.unsupported} · ${reason}`),
  });

  /**
   * An inbound message carrying `errors[]` is one Meta could not decrypt or
   * deliver to us intact. It is checked before the type switch because the
   * typed payload is the thing that is missing — treating it as, say, an image
   * with a null media id would push the failure into the media worker, where
   * the cause is no longer visible.
   */
  if ((message.errors ?? []).length > 0 && type !== 'text') {
    return {
      ...unsupported(errorDetail ?? `Mensagem não recebida (${base.errorCode ?? 'erro'})`),
    };
  }

  switch (type) {
    case 'text': {
      const body = message.text?.body ?? '';

      return {
        ...base,
        messageType: MESSAGE_TYPE.TEXT,
        body,
        payload: null,
        preview: truncatePreview(body),
      };
    }

    case 'image':
    case 'video':
    case 'audio':
    case 'sticker':
    case 'document': {
      const media = message[type] as MetaMediaPayload | undefined;
      const meta = mediaMetaFrom(media, {
        filename: (message.document as { filename?: string } | undefined)?.filename,
        voice: (message.audio as { voice?: boolean } | undefined)?.voice,
        animated: (message.sticker as { animated?: boolean } | undefined)?.animated,
      });

      const messageType = {
        image: MESSAGE_TYPE.IMAGE,
        video: MESSAGE_TYPE.VIDEO,
        audio: MESSAGE_TYPE.AUDIO,
        sticker: MESSAGE_TYPE.STICKER,
        document: MESSAGE_TYPE.DOCUMENT,
      }[type];

      // Documents caption to their filename; everything else to `caption`.
      const caption =
        type === 'document'
          ? (trimToNull(media?.caption) ?? meta.filename)
          : trimToNull(media?.caption);

      return {
        ...base,
        messageType,
        body: caption,
        payload: (media ?? null) as Record<string, unknown> | null,
        mediaMeta: meta,
        isMedia: MEDIA_TYPES.has(type),
        preview: mediaPreview(meta, messageType, trimToNull(media?.caption)),
      };
    }

    case 'location': {
      const location = message.location ?? {};
      const label =
        trimToNull(location.name) ??
        trimToNull(location.address) ??
        `${location.latitude ?? '?'}, ${location.longitude ?? '?'}`;

      return {
        ...base,
        messageType: MESSAGE_TYPE.LOCATION,
        body: label,
        payload: location as Record<string, unknown>,
        preview: truncatePreview(`${MEDIA_PREVIEW_LABELS.location} · ${label}`),
      };
    }

    case 'contacts': {
      const name = contactName(message.contacts);

      return {
        ...base,
        messageType: MESSAGE_TYPE.CONTACTS,
        body: name,
        payload: { contacts: message.contacts ?? [] },
        preview: truncatePreview(
          name === null
            ? MEDIA_PREVIEW_LABELS.contacts
            : `${MEDIA_PREVIEW_LABELS.contacts} · ${name}`,
        ),
      };
    }

    case 'reaction': {
      // An empty emoji means the reaction was *removed* — the same webhook
      // shape carries both add and remove (specs/12 §4).
      const emoji = message.reaction?.emoji ?? '';

      return {
        ...base,
        messageType: MESSAGE_TYPE.REACTION,
        body: emoji,
        payload: { emoji, messageId: message.reaction?.message_id ?? null },
        reactionTargetWamid: trimToNull(message.reaction?.message_id),
        preview: truncatePreview(emoji.length === 0 ? '' : emoji),
      };
    }

    case 'interactive': {
      const interactive = message.interactive ?? {};

      if (interactive.type === 'button_reply') {
        const reply = interactive.button_reply ?? {};

        return {
          ...base,
          messageType: MESSAGE_TYPE.BUTTON_REPLY,
          body: reply.title ?? '',
          payload: { id: reply.id ?? null, title: reply.title ?? null },
          preview: truncatePreview(reply.title ?? ''),
        };
      }

      if (interactive.type === 'list_reply') {
        const reply = interactive.list_reply ?? {};

        return {
          ...base,
          messageType: MESSAGE_TYPE.LIST_REPLY,
          body: reply.title ?? '',
          payload: {
            id: reply.id ?? null,
            title: reply.title ?? null,
            description: reply.description ?? null,
          },
          preview: truncatePreview(reply.title ?? ''),
        };
      }

      // Flows (`nfm_reply`) and any future interactive subtype: kept as
      // `interactive` with the raw payload, so a Flow response is readable in
      // the record even before the UI learns to render it.
      const nfm = interactive.nfm_reply as { body?: string } | undefined;
      const body = trimToNull(nfm?.body) ?? `Resposta interactiva (${interactive.type ?? 'desconhecida'})`;

      return {
        ...base,
        messageType: MESSAGE_TYPE.INTERACTIVE,
        body,
        payload: interactive as Record<string, unknown>,
        preview: truncatePreview(body),
      };
    }

    case 'button': {
      // A template quick-reply tap. Meta models it as its own top-level type,
      // not as `interactive`, but it is the same thing to a rep reading the
      // thread — so it stores as `button_reply`.
      const button = message.button ?? {};

      return {
        ...base,
        messageType: MESSAGE_TYPE.BUTTON_REPLY,
        body: button.text ?? '',
        payload: { payload: button.payload ?? null, text: button.text ?? null },
        preview: truncatePreview(button.text ?? ''),
      };
    }

    case 'system': {
      const body = trimToNull(message.system?.body) ?? 'Mensagem de sistema';

      return {
        ...base,
        messageType: MESSAGE_TYPE.SYSTEM,
        body,
        payload: (message.system ?? null) as Record<string, unknown> | null,
        preview: truncatePreview(body),
      };
    }

    default:
      return unsupported(`Tipo de mensagem não suportado: ${type}`);
  }
};
