import { describe, expect, it } from 'vitest';

import type { MessageContentProjection } from './content';
import { EMPTY_MEDIA } from './media';
import { attachQuotes, projectQuote, quotePreview, quotedWamids } from './quote';

const quotable = (overrides: Partial<Parameters<typeof attachQuotes>[0][number]>) => ({
  contextWamid: null,
  wamid: null,
  direction: 'INBOUND' as string | null,
  type: 'TEXT' as string | null,
  content: { kind: 'text', body: '' } as MessageContentProjection,
  media: null as { url: string | null; kind: string | null } | null,
  quote: null,
  ...overrides,
});

describe('quotePreview', () => {
  it('describes each kind with the line a reader would recognise', () => {
    expect(quotePreview({ kind: 'text', body: 'Bom dia' })).toBe('Bom dia');
    expect(
      quotePreview({
        kind: 'location',
        name: 'Talatona Office',
        address: 'Rua Centro',
        latitude: 0,
        longitude: 0,
      }),
    ).toBe('Talatona Office');
    expect(
      quotePreview({
        kind: 'image',
        media: { ...EMPTY_MEDIA, fileName: 'foto.jpg' },
        caption: null,
      }),
    ).toBe('foto.jpg');
  });

  /**
   * A sticker and a voice note have no words. Inventing some here would put an
   * untranslated English label into a Portuguese screen; the empty string is
   * the signal for the component to use its own type label instead.
   */
  it('says nothing for a message that has no words of its own', () => {
    expect(quotePreview({ kind: 'sticker', media: null })).toBe('');
    expect(quotePreview({ kind: 'audio', media: null, isVoice: true })).toBe('');
  });

  it('collapses and truncates rather than sending a paragraph down the wire', () => {
    const preview = quotePreview({ kind: 'text', body: `${'a'.repeat(200)}\n\nb` });

    expect(preview.length).toBe(90);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('projectQuote', () => {
  it('names the customer for their message and nobody for ours', () => {
    const theirs = projectQuote(
      quotable({ wamid: 'wamid.1', direction: 'INBOUND' }),
      'Marcos',
    );
    const ours = projectQuote(
      quotable({ wamid: 'wamid.2', direction: 'OUTBOUND' }),
      'Marcos',
    );

    expect(theirs?.senderLabel).toBe('Marcos');
    // "You" is copy; the component owns pt/en (specs/01 §7).
    expect(ours?.senderLabel).toBeNull();
    expect(ours?.direction).toBe('OUTBOUND');
  });

  it('offers a thumbnail only where a 40px square means something', () => {
    const media = { url: 'https://host/f1?token=x', kind: 'IMAGE' };

    expect(
      projectQuote(
        quotable({
          wamid: 'w1',
          media,
          content: { kind: 'image', media: EMPTY_MEDIA, caption: null },
        }),
        null,
      )?.thumbnailUrl,
    ).toBe('https://host/f1?token=x');

    expect(
      projectQuote(
        quotable({
          wamid: 'w2',
          media,
          content: { kind: 'document', media: EMPTY_MEDIA, caption: null },
        }),
        null,
      )?.thumbnailUrl,
    ).toBeNull();
  });
});

describe('quotedWamids', () => {
  it('asks only for quotes that reach outside the loaded page', () => {
    expect(
      quotedWamids([
        { wamid: 'a', contextWamid: null },
        { wamid: 'b', contextWamid: 'a' },
        { wamid: 'c', contextWamid: 'older' },
        { wamid: 'd', contextWamid: 'older' },
      ]),
    ).toEqual(['older']);
  });

  it('asks for nothing when nothing quotes anything', () => {
    expect(quotedWamids([{ wamid: 'a', contextWamid: null }])).toEqual([]);
  });
});

describe('attachQuotes', () => {
  it('resolves from the page first and from the extra read second', () => {
    const page = [
      quotable({ wamid: 'a', content: { kind: 'text', body: 'A morada é ali' } }),
      quotable({ wamid: 'b', contextWamid: 'a' }),
      quotable({ wamid: 'c', contextWamid: 'older' }),
    ];

    const attached = attachQuotes(
      page,
      [quotable({ wamid: 'older', content: { kind: 'text', body: 'Bom dia' } })],
      'Marcos',
    );

    expect(attached[1]?.quote?.preview).toBe('A morada é ali');
    expect(attached[2]?.quote?.preview).toBe('Bom dia');
  });

  /**
   * A quote we cannot describe stays null rather than becoming a stub. "In
   * reply to a message" told the reader nothing they could act on, which is
   * the finding this whole projection exists to answer.
   */
  it('leaves an unresolvable quote null rather than rendering a stub', () => {
    const attached = attachQuotes([quotable({ wamid: 'b', contextWamid: 'gone' })], [], null);

    expect(attached[0]?.quote).toBeNull();
  });
});
