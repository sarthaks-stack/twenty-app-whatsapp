import { describe, expect, it } from 'vitest';

import type { ContactCardProjection, MessageContentProjection } from './content';
import { attachContactMatches, contactPhoneCandidates } from './contact-match';

const card = (overrides: Partial<ContactCardProjection> = {}): ContactCardProjection => ({
  formattedName: 'Abel Febere',
  firstName: 'Abel',
  lastName: null,
  organization: null,
  title: null,
  phones: [{ phone: '+244 923 000 000', waId: '244923000000', type: 'CELL' }],
  emails: [],
  ...overrides,
});

const message = (content: MessageContentProjection) => ({ content });

describe('contactPhoneCandidates', () => {
  it('offers both spellings of every number, deduplicated', () => {
    expect(
      contactPhoneCandidates([
        card(),
        // The same card again — a rep forwarding a contact the customer sent.
        card(),
      ]),
    ).toEqual(['244923000000', '+244 923 000 000']);
  });

  it('asks for nothing when no card carries a number', () => {
    expect(contactPhoneCandidates([card({ phones: [] })])).toEqual([]);
  });
});

describe('attachContactMatches', () => {
  it('writes the match onto the card the resolver recognised', () => {
    const messages = [
      message({ kind: 'contacts', contacts: [card()] }),
      message({ kind: 'text', body: 'Bom dia' }),
    ];

    const attached = attachContactMatches(messages, () => 'p-1');

    expect(
      (attached[0]!.content as Extract<MessageContentProjection, { kind: 'contacts' }>)
        .contacts[0]?.matchedPersonId,
    ).toBe('p-1');
    // Untouched: only contact cards carry a match.
    expect(attached[1]).toBe(messages[1]);
  });

  /**
   * Null is "no match found", never "no such person could exist" — it is the
   * state that offers **Create person**, and the card must not act on it by
   * itself.
   */
  it('records a miss as null rather than dropping the field', () => {
    const attached = attachContactMatches(
      [message({ kind: 'contacts', contacts: [card()] })],
      () => null,
    );

    expect(
      (attached[0]!.content as Extract<MessageContentProjection, { kind: 'contacts' }>)
        .contacts[0],
    ).toMatchObject({ matchedPersonId: null });
  });

  it('leaves a contacts message with no cards exactly as it was', () => {
    const messages = [message({ kind: 'contacts', contacts: [] })];

    expect(attachContactMatches(messages, () => 'p-1')[0]).toBe(messages[0]);
  });
});
