import type {
  ContactCardProjection,
  MessageContentProjection,
} from '../../../domain/feed/content';
import type { MessageProjection } from '../../../domain/feed/projection';
import type { Translate } from '../../common/copy';
import type { IconName } from '../../common/icons';
import {
  AudioFileContent,
  DocumentContent,
  ImageContent,
  StickerContent,
  VideoContent,
  VoiceContent,
} from './media';
import {
  ContactsContent,
  InteractiveContent,
  InteractiveReplyContent,
  LocationContent,
  SystemContent,
  TemplateContent,
  TextContent,
  UnsupportedContent,
} from './rich';

/**
 * One switch, in one file (spec §"Rich message renderer registry").
 *
 * `MessageBubble` used to hold this decision as a chain of `if`s interleaved
 * with layout, and each new WhatsApp feature added one more — which is why the
 * types that arrived latest are the ones that rendered worst. The split is:
 * **MessageShell owns the row** (direction, grouping, quote, actions,
 * reactions, status, time) and **a renderer owns the content**. Neither knows
 * anything about the other's job.
 *
 * The registry also answers the two questions the shell needs to ask *about* a
 * renderer without rendering it: whether the content wants a bubble at all, and
 * which actions make sense for it.
 */

export type RendererCallbacks = {
  onDownload?: (message: MessageProjection) => void;
  /**
   * Takes the card, not the message: a `contacts` message can carry several,
   * and the rep creates the one they pressed.
   */
  onCreatePerson?: (contact: ContactCardProjection) => void;
  /** Cards whose create is in flight, keyed by `contactKey`. */
  creatingContacts?: ReadonlySet<string>;
};

export const MessageContent = ({
  message,
  t,
  callbacks,
}: {
  message: MessageProjection;
  t: Translate;
  callbacks: RendererCallbacks;
}) => {
  const content = message.content;
  const download =
    callbacks.onDownload === undefined
      ? undefined
      : () => callbacks.onDownload?.(message);

  switch (content.kind) {
    case 'text':
      return <TextContent body={content.body} />;

    case 'image':
      return (
        <ImageContent
          media={content.media}
          caption={content.caption}
          t={t}
          onDownload={download}
        />
      );

    case 'video':
      return (
        <VideoContent
          media={content.media}
          caption={content.caption}
          t={t}
          onDownload={download}
        />
      );

    case 'audio':
      /**
       * The one branch the spec singles out: a voice note and an audio file
       * are different messages, and the stored flag is the only thing that
       * tells them apart — the bytes do not.
       */
      return content.isVoice ? (
        <VoiceContent media={content.media} t={t} onDownload={download} />
      ) : (
        <AudioFileContent media={content.media} t={t} onDownload={download} />
      );

    case 'document':
      return (
        <DocumentContent
          media={content.media}
          caption={content.caption}
          t={t}
          onDownload={download}
        />
      );

    case 'sticker':
      return <StickerContent media={content.media} t={t} onDownload={download} />;

    case 'location':
      return (
        <LocationContent
          name={content.name}
          address={content.address}
          latitude={content.latitude}
          longitude={content.longitude}
          t={t}
        />
      );

    case 'contacts':
      return (
        <ContactsContent
          contacts={content.contacts}
          t={t}
          {...(callbacks.creatingContacts === undefined
            ? {}
            : { creating: callbacks.creatingContacts })}
          {...(callbacks.onCreatePerson === undefined
            ? {}
            : { onCreatePerson: callbacks.onCreatePerson })}
        />
      );

    case 'interactive':
      return <InteractiveContent interactive={content.interactive} t={t} />;

    case 'interactiveReply':
      return <InteractiveReplyContent reply={content.reply} t={t} />;

    case 'template':
      return <TemplateContent template={content.template} t={t} />;

    case 'system':
      return <SystemContent body={content.body} t={t} />;

    case 'reaction':
      /**
       * Never reached from the transcript: the feed route drops reaction rows,
       * because a reaction belongs on the bubble it is about and not between
       * two sentences. The branch exists so the union stays exhaustive — an
       * unhandled kind would render nothing at all and look like a bug.
       */
      return <SystemContent body={content.emoji} t={t} />;

    case 'unsupported':
      return (
        <UnsupportedContent sourceType={content.sourceType} body={content.body} t={t} />
      );
  }
};

/**
 * Content that supplies its own shape.
 *
 * A sticker on a bubble background is a grey box around something drawn to sit
 * transparently on the conversation; a system event in a bubble looks like
 * something a person said. Both keep their row, their actions and their
 * grouping — they simply do not get the chrome.
 */
export const isChromeless = (content: MessageContentProjection): boolean =>
  content.kind === 'sticker' || content.kind === 'system';

/** Which actions the toolbar should offer for this content (spec's action table). */
export type ContentActions = {
  canCopy: boolean;
  canDownload: boolean;
};

export const actionsFor = (content: MessageContentProjection): ContentActions => {
  switch (content.kind) {
    case 'text':
      return { canCopy: content.body.length > 0, canDownload: false };
    case 'image':
    case 'video':
    case 'document':
      return {
        canCopy: (content.caption ?? '').length > 0,
        canDownload: content.media?.url !== null && content.media !== null,
      };
    case 'audio':
    case 'sticker':
      return {
        canCopy: false,
        canDownload: content.media?.url !== null && content.media !== null,
      };
    case 'location':
      return {
        // The address, not the coordinates: what a rep pastes into a message.
        canCopy: (content.address ?? content.name ?? '').length > 0,
        canDownload: false,
      };
    case 'contacts':
      return { canCopy: content.contacts.length > 0, canDownload: false };
    case 'template':
      return { canCopy: (content.template.body ?? '').length > 0, canDownload: false };
    case 'interactive':
      return {
        canCopy:
          content.interactive.kind !== 'other' && content.interactive.body !== null,
        canDownload: false,
      };
    case 'interactiveReply':
      return { canCopy: content.reply.title !== null, canDownload: false };
    case 'reaction':
    case 'system':
    case 'unsupported':
      return { canCopy: false, canDownload: false };
  }
};

/**
 * The one line a rep copies, which is the *customer-visible* content and never
 * an internal field — the spec is explicit that Copy must not lift webhook or
 * operational metadata out of a bubble.
 */
export const copyableText = (content: MessageContentProjection): string | null => {
  switch (content.kind) {
    case 'text':
      return content.body;
    case 'image':
    case 'video':
    case 'document':
      return content.caption;
    case 'location':
      return [content.name, content.address].filter((part) => part !== null).join(', ') || null;
    case 'contacts':
      return (
        content.contacts
          .map((contact) =>
            [
              contact.formattedName ?? contact.firstName,
              contact.phones[0]?.phone,
            ]
              .filter((part) => part !== null && part !== undefined)
              .join(' · '),
          )
          .join('\n') || null
      );
    case 'template':
      return content.template.body;
    case 'interactive':
      return content.interactive.kind === 'other' ? null : content.interactive.body;
    case 'interactiveReply':
      return content.reply.title;
    default:
      return null;
  }
};

/** The type label and icon a quote strip and the details panel both show. */
export const TYPE_ICON: Record<string, IconName> = {
  TEXT: 'replies',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  STICKER: 'sticker',
  LOCATION: 'location',
  CONTACTS: 'contactCard',
  TEMPLATE: 'template',
  INTERACTIVE: 'quickReplies',
  BUTTON_REPLY: 'quickReplies',
  LIST_REPLY: 'listMessage',
  REACTION: 'react',
  SYSTEM: 'details',
};

export const typeIconFor = (type: string | null): IconName =>
  TYPE_ICON[type ?? ''] ?? 'consentUnknown';

/**
 * A translated type name, falling back to the key itself.
 *
 * `t` renders an unknown key as the key, which is ugly and unmistakable — the
 * right trade for a string somebody forgot, and far better than the silence
 * that would read as "this message has no type".
 */
export const typeLabelFor = (type: string | null, t: Translate): string =>
  type === null ? t('chat.unsupported') : t(`chat.type.${type}`);
