import { MESSAGE_TYPE } from '../constants';
import { effectiveKind, type MediaProjection } from './media';

/**
 * What a message *is*, as a product model rather than as a webhook (specs/08 §2).
 *
 * Before this existed, `MessageBubble` grew one more `if` per WhatsApp feature:
 * it read `message.payload` — Meta's raw inbound object for an inbound row and
 * our own `SendSpec` for an outbound one — and guessed. Two wire formats, both
 * owned by somebody else, parsed in a component that also has to lay out a
 * bubble. A location rendered as `-8.9126, 13.2334` for exactly that reason: no
 * one place was answerable for turning "the payload" into "a place".
 *
 * So the seam moves. The server answers with a discriminated union the renderer
 * registry switches on once, `payload` stays server-side for audit, and a new
 * Meta field is a change here rather than in every component that renders one.
 *
 * Two rules carried over from `projection.ts` still hold:
 *
 * - **Machine codes, never prose.** Nothing below is a sentence. `kind` and
 *   `sourceType` are keys the pt/en tables translate; a label like "Voice
 *   message" is the component's to choose (specs/01 §7).
 * - **The server decides.** `isVoice` is decided from the stored media meta
 *   here, not re-derived from a MIME type in the browser, so the composer's
 *   voice-note send and the transcript's voice-note card agree by construction.
 */

export type ContactPhoneProjection = {
  phone: string;
  /** Present when the number is on WhatsApp; what a "message this contact" would use. */
  waId: string | null;
  type: string | null;
};

export type ContactEmailProjection = { email: string; type: string | null };

export type ContactCardProjection = {
  formattedName: string | null;
  firstName: string | null;
  lastName: string | null;
  organization: string | null;
  title: string | null;
  phones: ContactPhoneProjection[];
  emails: ContactEmailProjection[];
  /**
   * The Person this card already is, if the CRM knows them.
   *
   * Filled in by the feed route's batched lookup (`contact-match.ts`), never by
   * the projection itself — a pure function over one message cannot know what
   * else is in the workspace. Null means "no match found", which is the state
   * that offers **Create person**; it is never a claim that no such person
   * could exist.
   */
  matchedPersonId?: string | null;
};

export type InteractiveButtonProjection = { id: string; title: string };

export type InteractiveRowProjection = {
  id: string;
  title: string;
  description: string | null;
};

export type InteractiveSectionProjection = {
  title: string | null;
  rows: InteractiveRowProjection[];
};

/**
 * An interactive message *we sent*, as the customer saw it.
 *
 * `other` is not a failure branch. Meta adds interactive subtypes faster than
 * any CRM adopts them, and a message that reached a customer must stay readable
 * in the transcript whether or not this app learned to compose that subtype
 * (FR-IN-1's "placeholder rather than dropped", applied outbound).
 */
export type InteractiveProjection =
  | {
      kind: 'buttons';
      header: string | null;
      body: string | null;
      footer: string | null;
      buttons: InteractiveButtonProjection[];
    }
  | {
      kind: 'list';
      header: string | null;
      body: string | null;
      footer: string | null;
      buttonText: string | null;
      sections: InteractiveSectionProjection[];
    }
  | { kind: 'other'; interactiveType: string | null; body: string | null };

/**
 * A customer's *answer* to an interactive message.
 *
 * Kept distinct from `text` on purpose. "Sim" typed into the box and "Sim"
 * tapped as a quick reply are the same three characters and completely
 * different facts — the second one names a button the business authored, and an
 * automation keyed off `id` behaves differently for each. The transcript said
 * "Sim" for both until now.
 */
export type InteractiveReplyProjection = {
  kind: 'button' | 'list' | 'flow';
  /** The id the business chose when it authored the button/row, when Meta echoes one. */
  id: string | null;
  title: string | null;
  description: string | null;
  /** Flow responses only: flattened scalar answers, safe to show without a payload dump. */
  fields: { key: string; value: string }[];
};

export type TemplateMessageProjection = {
  name: string | null;
  language: string | null;
  category: string | null;
  /** Already rendered with this send's parameters by `renderTemplateBody`. */
  body: string | null;
};

export type MessageContentProjection =
  | { kind: 'text'; body: string }
  | { kind: 'image'; media: MediaProjection | null; caption: string | null }
  | { kind: 'video'; media: MediaProjection | null; caption: string | null }
  | { kind: 'audio'; media: MediaProjection | null; isVoice: boolean }
  | { kind: 'document'; media: MediaProjection | null; caption: string | null }
  | { kind: 'sticker'; media: MediaProjection | null }
  | {
      kind: 'location';
      name: string | null;
      address: string | null;
      latitude: number | null;
      longitude: number | null;
    }
  | { kind: 'contacts'; contacts: ContactCardProjection[] }
  | { kind: 'interactive'; interactive: InteractiveProjection }
  | { kind: 'interactiveReply'; reply: InteractiveReplyProjection }
  | { kind: 'template'; template: TemplateMessageProjection }
  | { kind: 'reaction'; emoji: string; targetWamid: string | null }
  | { kind: 'system'; body: string | null }
  | { kind: 'unsupported'; sourceType: string | null; body: string | null };

export type ContentSource = {
  type: string | null;
  direction: string | null;
  body: string | null;
  payload: Record<string, unknown> | null;
  media: MediaProjection | null;
  templateName: string | null;
  templateLanguage: string | null;
  templateCategory: string | null;
  reactionTargetWamid: string | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const text = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim().length === 0 ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  return null;
};

const finite = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

/**
 * One contact card, from either wire shape.
 *
 * Meta nests `name.formatted_name`, `org.company` and `org.title`; our own
 * outbound `SendSpec` carries the identical structure because it is passed
 * through to `buildContactsPayload` untouched. So one reader serves both, and
 * the shared-contact card looks the same whichever direction it travelled.
 */
export const projectContactCard = (value: unknown): ContactCardProjection | null => {
  const card = asRecord(value);

  if (card === null) return null;

  const name = asRecord(card.name);
  const org = asRecord(card.org);

  const phones = asArray(card.phones).flatMap((entry): ContactPhoneProjection[] => {
    const phone = asRecord(entry);
    const number = text(phone?.phone) ?? text(phone?.wa_id);

    return number === null
      ? []
      : [{ phone: number, waId: text(phone?.wa_id), type: text(phone?.type) }];
  });

  const emails = asArray(card.emails).flatMap((entry): ContactEmailProjection[] => {
    const email = asRecord(entry);
    const address = text(email?.email);

    return address === null ? [] : [{ email: address, type: text(email?.type) }];
  });

  const formattedName = text(name?.formatted_name);
  const firstName = text(name?.first_name);

  if (
    formattedName === null &&
    firstName === null &&
    phones.length === 0 &&
    emails.length === 0
  ) {
    return null;
  }

  return {
    formattedName,
    firstName,
    lastName: text(name?.last_name),
    organization: text(org?.company),
    title: text(org?.title),
    phones,
    emails,
  };
};

/** Meta writes `{ text: "…" }` for a header/footer/body and sometimes a bare string. */
const blockText = (value: unknown): string | null =>
  text(asRecord(value)?.text) ?? text(value);

/**
 * An outbound `interactive` object, as authored by the builder and stored on
 * the `SendSpec`. Read defensively because the same field also accepts anything
 * a workflow author put there before the route validator existed.
 */
export const projectInteractive = (value: unknown): InteractiveProjection => {
  const interactive = asRecord(value);
  const type = text(interactive?.type);
  const header = blockText(interactive?.header);
  const body = blockText(interactive?.body);
  const footer = blockText(interactive?.footer);
  const action = asRecord(interactive?.action);

  if (type === 'button') {
    return {
      kind: 'buttons',
      header,
      body,
      footer,
      buttons: asArray(action?.buttons).flatMap((entry): InteractiveButtonProjection[] => {
        const reply = asRecord(asRecord(entry)?.reply);
        const title = text(reply?.title);

        return title === null ? [] : [{ id: text(reply?.id) ?? '', title }];
      }),
    };
  }

  if (type === 'list') {
    return {
      kind: 'list',
      header,
      body,
      footer,
      buttonText: text(action?.button),
      sections: asArray(action?.sections).flatMap(
        (entry): InteractiveSectionProjection[] => {
          const section = asRecord(entry);

          if (section === null) return [];

          return [
            {
              title: text(section.title),
              rows: asArray(section.rows).flatMap((rowValue): InteractiveRowProjection[] => {
                const row = asRecord(rowValue);
                const title = text(row?.title);

                return title === null
                  ? []
                  : [
                      {
                        id: text(row?.id) ?? '',
                        title,
                        description: text(row?.description),
                      },
                    ];
              }),
            },
          ];
        },
      ),
    };
  }

  return { kind: 'other', interactiveType: type, body };
};

/**
 * A Flow response, reduced to the scalars a rep can read.
 *
 * Meta's `nfm_reply.response_json` is a JSON *string* of whatever the Flow
 * author defined, so nothing here can be typed. Only scalars are lifted, and
 * only from the top level: a nested object is a structure this app has no
 * agreed presentation for, and printing it would be the raw-payload dump the
 * details panel was built to stop showing.
 */
const flowFields = (interactive: Record<string, unknown>): { key: string; value: string }[] => {
  const nfm = asRecord(interactive.nfm_reply);
  const raw = nfm?.response_json;

  const parsed = ((): Record<string, unknown> | null => {
    if (typeof raw === 'string') {
      try {
        return asRecord(JSON.parse(raw));
      } catch {
        return null;
      }
    }

    return asRecord(raw);
  })();

  if (parsed === null) return [];

  return Object.entries(parsed).flatMap(([key, value]) => {
    if (key === 'flow_token') return [];

    const scalar =
      typeof value === 'boolean' ? String(value) : text(value);

    return scalar === null ? [] : [{ key, value: scalar }];
  });
};

/**
 * The `SendSpec` an outbound row stores, distinguished from Meta's inbound
 * shape by the `kind` discriminant our own writer always sets.
 */
const isSendSpec = (payload: Record<string, unknown> | null): boolean =>
  typeof payload?.kind === 'string';

/**
 * The whole registry key, decided once (specs/08 §3.2).
 *
 * Exported and pure because every renderer, every preview and every quote
 * strip must agree on what a message *is*; a component that re-decided would
 * eventually draw an audio card over a document renderer's actions.
 */
export const projectContent = (source: ContentSource): MessageContentProjection => {
  const payload = source.payload;
  const media = source.media;
  const spec = isSendSpec(payload) ? payload : null;
  const caption = source.body;

  switch (source.type) {
    case MESSAGE_TYPE.TEXT:
      return { kind: 'text', body: source.body ?? '' };

    case MESSAGE_TYPE.IMAGE:
    case MESSAGE_TYPE.VIDEO:
    case MESSAGE_TYPE.AUDIO:
    case MESSAGE_TYPE.STICKER:
    case MESSAGE_TYPE.DOCUMENT: {
      /**
       * What the media *is*, not what Meta labelled it.
       *
       * An MP3 sent from the device's document picker arrives as
       * `type: document` with `mime_type: audio/mpeg`, and keying the renderer
       * on the stored type gives a customer who plainly sent audio a download
       * link with a file icon — which is exactly what the transcript did. The
       * inbound normaliser has drawn this distinction since it was written
       * (`effectiveMediaKind`); the projection had not, so only the *preview*
       * benefited from it.
       *
       * The stored `messageType` stays faithful to Meta either way. This
       * decides presentation, and nothing else.
       */
      switch (effectiveKind(media)) {
        case 'image':
          return { kind: 'image', media, caption };
        case 'video':
          return { kind: 'video', media, caption };
        case 'audio':
          return { kind: 'audio', media, isVoice: media?.isVoice === true };
        case 'sticker':
          return { kind: 'sticker', media };
        default:
          /**
           * A document with no caption is stored with its filename as the body
           * (specs/03 §4.1), which is right for the inbox preview and wrong
           * here — the card already prints the filename, and repeating it
           * reads as a bug.
           */
          return {
            kind: 'document',
            media,
            caption: caption === media?.fileName ? null : caption,
          };
      }
    }

    case MESSAGE_TYPE.LOCATION: {
      const source_ = spec ?? payload;

      return {
        kind: 'location',
        name: text(source_?.name),
        address: text(source_?.address),
        latitude: finite(source_?.latitude),
        longitude: finite(source_?.longitude),
      };
    }

    case MESSAGE_TYPE.CONTACTS:
      return {
        kind: 'contacts',
        contacts: asArray(payload?.contacts).flatMap((entry) => {
          const card = projectContactCard(entry);

          return card === null ? [] : [card];
        }),
      };

    case MESSAGE_TYPE.TEMPLATE:
      return {
        kind: 'template',
        template: {
          name: source.templateName,
          language: source.templateLanguage,
          category: source.templateCategory,
          body: source.body,
        },
      };

    case MESSAGE_TYPE.REACTION:
      return {
        kind: 'reaction',
        emoji: source.body ?? text(payload?.emoji) ?? '',
        targetWamid: source.reactionTargetWamid,
      };

    case MESSAGE_TYPE.BUTTON_REPLY:
      return {
        kind: 'interactiveReply',
        reply: {
          kind: 'button',
          // A template quick-reply arrives as `{payload, text}`; an interactive
          // reply button as `{id, title}`. Both are "the button they pressed".
          id: text(payload?.id) ?? text(payload?.payload),
          title: text(payload?.title) ?? text(payload?.text) ?? source.body,
          description: null,
          fields: [],
        },
      };

    case MESSAGE_TYPE.LIST_REPLY:
      return {
        kind: 'interactiveReply',
        reply: {
          kind: 'list',
          id: text(payload?.id),
          title: text(payload?.title) ?? source.body,
          description: text(payload?.description),
          fields: [],
        },
      };

    case MESSAGE_TYPE.INTERACTIVE: {
      /**
       * The one type whose direction changes its meaning. Outbound is an
       * interactive message *we composed*; inbound is a Flow-style *answer*.
       */
      if (spec !== null) {
        return { kind: 'interactive', interactive: projectInteractive(spec.interactive) };
      }

      const interactive = payload ?? {};

      return {
        kind: 'interactiveReply',
        reply: {
          kind: 'flow',
          id: null,
          title: source.body,
          description: null,
          fields: flowFields(interactive),
        },
      };
    }

    case MESSAGE_TYPE.SYSTEM:
      return { kind: 'system', body: source.body };

    default:
      return {
        kind: 'unsupported',
        sourceType: source.type,
        body: source.body,
      };
  }
};
