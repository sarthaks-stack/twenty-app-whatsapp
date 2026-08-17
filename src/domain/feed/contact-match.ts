import type { ContactCardProjection } from './content';

/**
 * Whether a shared contact card is somebody the CRM already knows
 * (spec §"Shared contacts").
 *
 * The card without this answers only "here is a name and a number". The rep's
 * actual question is "do we have this person?", and the three outcomes have
 * three different next actions — open them, review and create them, or nothing.
 * Guessing wrong in the create direction writes a third party's details into
 * the CRM without anyone deciding to, which is why the card never acts on the
 * answer by itself.
 *
 * Resolved on the server, in one batched query for the whole page, for the same
 * reason quotes are: a lookup per card is an N+1 on a surface that polls every
 * three seconds.
 */

/**
 * A stable key for one card, so an in-flight create can be tracked against it.
 *
 * Needed because **Create person** is a write with no optimistic state of its
 * own: the card only stops offering it once the server's next poll reports a
 * match, which is up to three seconds later. Without a key to disable, a rep
 * who presses twice in that window creates the same person twice — which is
 * not hypothetical, it is what happens the first time anyone tries it.
 *
 * Built from the name and the first number rather than an index, so it survives
 * the page re-ordering underneath it.
 */
export const contactKey = (card: ContactCardProjection): string =>
  [
    card.formattedName ?? card.firstName ?? '',
    card.phones[0]?.waId ?? card.phones[0]?.phone ?? '',
  ].join('|');

/**
 * Every number worth looking a Person up by, across a page of messages.
 *
 * Deduplicated, because a page frequently carries the same card twice — a rep
 * forwarding a contact, then the customer re-sending it — and because a
 * repeated number in an `or:` filter costs a clause for nothing.
 */
export const contactPhoneCandidates = (
  cards: ContactCardProjection[],
): string[] => [
  ...new Set(
    cards.flatMap((card) =>
      card.phones.flatMap((phone) =>
        [phone.waId, phone.phone].filter((value): value is string => value !== null),
      ),
    ),
  ),
];

type Matchable = {
  content: { kind: string; contacts?: ContactCardProjection[] };
};

/**
 * Writes the match onto each card.
 *
 * `resolve` takes the *card* rather than a phone so the caller can decide how
 * strictly to compare — the feed route normalises to E.164 first, because
 * `+244 923 000 000` and `244923000000` are one number written two ways and a
 * string comparison would call them two people.
 */
export const attachContactMatches = <T extends Matchable>(
  messages: T[],
  resolve: (card: ContactCardProjection) => string | null,
): T[] =>
  messages.map((message) => {
    if (message.content.kind !== 'contacts') return message;

    const contacts = message.content.contacts ?? [];

    if (contacts.length === 0) return message;

    return {
      ...message,
      content: {
        ...message.content,
        contacts: contacts.map((card) => ({ ...card, matchedPersonId: resolve(card) })),
      },
    };
  });
