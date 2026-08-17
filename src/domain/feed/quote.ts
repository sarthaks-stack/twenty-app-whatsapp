import type { MessageContentProjection } from './content';

/**
 * The message a reply is *about* (spec §"Reply UX").
 *
 * The wire has carried `contextWamid` since the first release and the bubble
 * has rendered it as the words "In reply to a message" ever since — a strip
 * that tells the reader a quote exists and nothing about what it quotes. The
 * missing half was never the id; it was that resolving the id needs a second
 * read, and doing it per bubble is an N+1 that still fails whenever the quoted
 * message sits outside the loaded page.
 *
 * So the server resolves them, once per feed read, in one batched query, and
 * sends this projection down with the messages. The component renders a quote;
 * it never looks one up.
 *
 * `senderLabel` is null for our own messages on purpose: "You" is copy, and
 * copy lives in the pt/en tables (specs/01 §7). `direction` is what the
 * component branches on.
 */
export type QuoteProjection = {
  wamid: string;
  direction: 'INBOUND' | 'OUTBOUND' | null;
  senderLabel: string | null;
  /** The quoted message's `MESSAGE_TYPE`, so the strip can show a type icon. */
  type: string | null;
  /**
   * One line of the quoted message, already plain text.
   *
   * Empty when the quoted message has no words of its own — a sticker, a
   * captionless image — and the component supplies a type label instead. It is
   * never a translated string, for the same reason `senderLabel` is not.
   */
  preview: string;
  thumbnailUrl: string | null;
};

const PREVIEW_MAX = 90;

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

export const truncateQuote = (value: string, max = PREVIEW_MAX): string => {
  const collapsed = collapse(value);

  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
};

/**
 * The one line a quote strip shows, chosen from the content union.
 *
 * Deliberately not `message.body`. A document's body is its filename, a
 * location's body is whatever label the normaliser picked, and a list reply's
 * body drops the description — all fine for an inbox preview, all subtly wrong
 * as "the thing you replied to". Reading the projected content instead means
 * the quote and the bubble it points at can never describe the message
 * differently.
 */
export const quotePreview = (content: MessageContentProjection): string => {
  switch (content.kind) {
    case 'text':
      return truncateQuote(content.body);
    case 'image':
    case 'video':
    case 'document':
      return truncateQuote(content.caption ?? content.media?.fileName ?? '');
    case 'audio':
    case 'sticker':
      return '';
    case 'location':
      return truncateQuote(content.name ?? content.address ?? '');
    case 'contacts':
      return truncateQuote(
        content.contacts[0]?.formattedName ?? content.contacts[0]?.firstName ?? '',
      );
    case 'interactive':
      return truncateQuote(
        content.interactive.kind === 'other'
          ? (content.interactive.body ?? '')
          : (content.interactive.body ?? content.interactive.header ?? ''),
      );
    case 'interactiveReply':
      return truncateQuote(content.reply.title ?? '');
    case 'template':
      return truncateQuote(content.template.body ?? '');
    case 'reaction':
      return content.emoji;
    case 'system':
    case 'unsupported':
      return truncateQuote(content.body ?? '');
  }
};

export type QuoteSource = {
  wamid: string | null;
  direction: string | null;
  type: string | null;
  content: MessageContentProjection;
  media: { url: string | null; kind: string | null } | null;
};

/**
 * Builds the strip from an already-projected message.
 *
 * A thumbnail is offered only for the types where a 40 px square means
 * anything. A document's signed URL in an `<img>` renders a broken-image icon,
 * which is worse than the type icon it would have replaced.
 */
export const projectQuote = (
  source: QuoteSource,
  senderLabel: string | null,
): QuoteProjection | null => {
  if (source.wamid === null) return null;

  const thumbnailKind = source.content.kind;
  const thumbnailUrl =
    thumbnailKind === 'image' || thumbnailKind === 'video' || thumbnailKind === 'sticker'
      ? (source.media?.url ?? null)
      : null;

  return {
    wamid: source.wamid,
    direction:
      source.direction === 'INBOUND' || source.direction === 'OUTBOUND'
        ? source.direction
        : null,
    senderLabel: source.direction === 'INBOUND' ? senderLabel : null,
    type: source.type,
    preview: quotePreview(source.content),
    thumbnailUrl,
  };
};

/** Every distinct message a page of messages quotes, ready for one `in:` query. */
export const quotedWamids = (
  messages: { contextWamid: string | null; wamid: string | null }[],
): string[] => {
  const own = new Set(
    messages.map((message) => message.wamid).filter((wamid): wamid is string => wamid !== null),
  );

  return [
    ...new Set(
      messages
        .map((message) => message.contextWamid)
        .filter((wamid): wamid is string => wamid !== null)
        // A quote of something already on the page needs no second read.
        .filter((wamid) => !own.has(wamid)),
    ),
  ];
};

type Quotable = {
  contextWamid: string | null;
  wamid: string | null;
  direction: string | null;
  type: string | null;
  content: MessageContentProjection;
  media: { url: string | null; kind: string | null } | null;
  quote: QuoteProjection | null;
};

/**
 * Fills each message's quote from the page it is already in, plus whatever the
 * single extra read found.
 *
 * The page comes first deliberately. Most replies quote something a few rows
 * up, so the common case costs no query at all, and the extra read only ever
 * covers quotes that reach outside the loaded window — which is exactly the
 * case a per-bubble lookup could never handle.
 *
 * A quote that resolves to nothing stays null rather than becoming a stub. The
 * message is genuinely older than this install, or was deleted, and "In reply
 * to a message" told the reader nothing they could act on.
 */
export const attachQuotes = <T extends Quotable>(
  messages: T[],
  extra: T[],
  contactLabel: string | null,
): T[] => {
  const byWamid = new Map<string, Quotable>();

  for (const message of [...messages, ...extra]) {
    if (message.wamid !== null) byWamid.set(message.wamid, message);
  }

  return messages.map((message) => {
    if (message.contextWamid === null) return message;

    const target = byWamid.get(message.contextWamid);

    if (target === undefined) return message;

    return { ...message, quote: projectQuote(target as QuoteSource, contactLabel) };
  });
};
