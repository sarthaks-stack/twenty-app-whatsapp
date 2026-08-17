import type { MessageProjection } from '../../domain/feed/projection';
import { fileSize } from '../common/format';

/**
 * The operational half of a message (spec §"Message details").
 *
 * This file used to carry a different job. When a location rendered as raw
 * coordinates and a shared contact as a bare name, "Ver detalhes" was the only
 * place a rep could find the address or the phone number — so it lifted them
 * out of the payload. The renderer registry now shows all of that *in* the
 * bubble, where it belongs, and the spec is explicit that no location or
 * contact should need a details panel to be understandable.
 *
 * So the panel becomes what it should always have been: when the message went
 * out, when it arrived, when it was read, what failed, which template was used
 * and which button id came back. Facts about the *delivery*, not the content —
 * and still never the raw webhook object, which is what the panel showed before
 * either version of this file existed.
 *
 * Pure, and keyed by copy key rather than by label, so the rows translate with
 * the rest of the surface. Timestamps are formatted by the caller, because the
 * reader's time zone rule (Africa/Luanda) is a rendering concern and this
 * module has no business knowing about it.
 */

export type DetailRow = { key: string; value: string };

export type TimeFormatter = (iso: string) => string;

const text = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim().length === 0 ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  return null;
};

/**
 * `statusTimestamps` holds epoch *seconds*, which is what Meta's webhooks send
 * and what the status processor stores. Treating them as milliseconds silently
 * dates every message to January 1970, which looks like a formatting bug and is
 * really a unit one.
 */
const asIso = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  if (typeof value === 'string' && value.length > 0) {
    const numeric = Number(value);

    if (Number.isFinite(numeric)) return new Date(numeric * 1000).toISOString();

    return Number.isNaN(Date.parse(value)) ? null : value;
  }

  return null;
};

/** The delivery story, in the order it happens. */
const TIMELINE: { field: string; key: string }[] = [
  { field: 'accepted', key: 'chat.detail.accepted' },
  { field: 'sent', key: 'chat.detail.sent' },
  { field: 'delivered', key: 'chat.detail.delivered' },
  { field: 'read', key: 'chat.detail.read' },
  { field: 'played', key: 'chat.detail.played' },
  { field: 'failed', key: 'chat.detail.failed' },
];

const contentRows = (message: MessageProjection): DetailRow[] => {
  const content = message.content;

  switch (content.kind) {
    /**
     * The ids, and only the ids. Title and description are in the bubble; the
     * id is the thing an automation keys off and the thing a rep cannot see
     * anywhere else.
     */
    case 'interactiveReply':
      return content.reply.id === null
        ? []
        : [
            {
              key:
                content.reply.kind === 'list'
                  ? 'chat.detail.rowId'
                  : 'chat.detail.buttonId',
              value: content.reply.id,
            },
          ];

    case 'template':
      return [
        ...(content.template.language === null
          ? []
          : [{ key: 'chat.detail.language', value: content.template.language }]),
        ...(content.template.category === null
          ? []
          : [{ key: 'chat.detail.category', value: content.template.category }]),
      ];

    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker': {
      const media = content.media;

      if (media === null) return [];

      const size = fileSize(media.sizeBytes);

      return [
        ...(media.fileName === null
          ? []
          : [{ key: 'chat.detail.file', value: media.fileName }]),
        ...(size.length === 0 ? [] : [{ key: 'chat.detail.size', value: size }]),
      ];
    }

    case 'contacts':
      /**
       * Only the emails, and only because the card shows phones first and an
       * email is the field most likely to be pushed off a narrow card. Nothing
       * else: the card is the place to read a contact.
       */
      return content.contacts.flatMap((contact) =>
        contact.emails.map((email) => ({
          key: 'chat.detail.email',
          value: email.email,
        })),
      );

    default:
      return [];
  }
};

export const messageDetails = (
  message: MessageProjection,
  formatTime: TimeFormatter = (iso) => iso,
): DetailRow[] => {
  const type = text(message.type);

  const timeline = TIMELINE.flatMap((step): DetailRow[] => {
    const iso = asIso(message.statusTimestamps[step.field]);

    return iso === null ? [] : [{ key: step.key, value: formatTime(iso) }];
  });

  const reactions =
    message.reactions.length === 0
      ? []
      : [
          {
            key: 'chat.detail.reactions',
            value: message.reactions
              .map((reaction) =>
                reaction.actorLabel === null
                  ? reaction.emoji
                  : `${reaction.emoji} ${reaction.actorLabel}`,
              )
              .join(' · '),
          },
        ];

  return [
    ...(type === null ? [] : [{ key: 'chat.detail.type', value: `chat.type.${type}` }]),
    ...(message.templateName === null
      ? []
      : [{ key: 'chat.detail.template', value: message.templateName }]),
    ...contentRows(message),
    ...timeline,
    ...(message.retryCount > 0
      ? [{ key: 'chat.detail.attempts', value: String(message.retryCount) }]
      : []),
    ...reactions,
  ];
};

/**
 * Whether the row's value is itself a copy key rather than data.
 *
 * The type row is the only one: `chat.type.IMAGE` must be translated, while
 * `Proposta.pdf` must not. Encoding that as a prefix rather than as a second
 * field keeps `DetailRow` a pair of strings, which is what makes this module
 * trivially testable.
 */
export const isCopyKey = (value: string): boolean => value.startsWith('chat.type.');
