import { describe, expect, it } from 'vitest';

import { projectThread, type ThreadProjection } from '../../domain/feed/projection';
import { filterThreads, matchesQuery, nextThreadId, threadName } from './list';

const thread = (over: Partial<ThreadProjection> = {}): ThreadProjection => ({
  ...projectThread({ id: over.id ?? 'thread-1' }),
  ...over,
});

const person = (firstName: string, lastName: string | null = null) => ({
  id: 'person-1',
  firstName,
  lastName,
  jobTitle: null,
  city: null,
  primaryEmail: null,
  primaryPhone: null,
  whatsappOptInStatus: null,
  whatsappOptInUpdatedAt: null,
  companyId: null,
});

/**
 * A row with no name is a row nobody can pick out of a list, and there are
 * three separate ways a conversation ends up without one.
 */
describe('threadName', () => {
  it('prefers the WhatsApp profile name — it is what the customer calls themselves', () => {
    expect(
      threadName(thread({ profileName: 'Zé da Padaria', person: person('José', 'Silva') })),
    ).toBe('Zé da Padaria');
  });

  it('falls back to the CRM name when there is no profile name', () => {
    expect(threadName(thread({ person: person('José', 'Silva') }))).toBe('José Silva');
  });

  it('falls back to the number rather than rendering an empty row', () => {
    expect(threadName(thread({ dialablePhone: '+244923456789' }))).toBe('+244 923 456 789');
  });

  it('uses the waId when even the dialable number is missing', () => {
    expect(threadName(thread({ waId: '244923456789' }))).not.toBe('');
  });
});

describe('matchesQuery', () => {
  it('matches nothing away when the query is blank', () => {
    expect(matchesQuery(thread({ profileName: 'Ana' }), '   ')).toBe(true);
  });

  it('ignores case', () => {
    expect(matchesQuery(thread({ profileName: 'Ana Paula' }), 'PAULA')).toBe(true);
  });

  /**
   * The market is Portuguese-speaking (A-6) and nobody types diacritics into a
   * search box. "joao" must find "João" or the field is decorative.
   */
  it('ignores accents in both the query and the name', () => {
    expect(matchesQuery(thread({ profileName: 'João Cação' }), 'joao')).toBe(true);
    expect(matchesQuery(thread({ profileName: 'Joao Cacao' }), 'joão')).toBe(true);
  });

  it('searches the last message preview, not only the name', () => {
    expect(
      matchesQuery(thread({ lastMessagePreview: 'a encomenda chegou?' }), 'encomenda'),
    ).toBe(true);
  });

  /**
   * The number is shown grouped and typed ungrouped. Matching only the display
   * string answers nothing for the most natural search anyone could run.
   */
  it('matches a number typed without spaces or a plus', () => {
    const row = thread({ dialablePhone: '+244 923 456 789' });

    expect(matchesQuery(row, '923456789')).toBe(true);
    expect(matchesQuery(row, '+244 923')).toBe(true);
  });

  /** Below three digits a stray "1" would match nearly every number in the list. */
  it('does not treat one or two digits as a phone search', () => {
    expect(matchesQuery(thread({ dialablePhone: '+244923456789' }), '9')).toBe(false);
  });

  it('answers false when nothing matches', () => {
    expect(matchesQuery(thread({ profileName: 'Ana' }), 'Bernardo')).toBe(false);
  });
});

describe('filterThreads', () => {
  it('keeps the server order and drops only what does not match', () => {
    const rows = [
      thread({ id: 'a', profileName: 'Ana' }),
      thread({ id: 'b', profileName: 'Bernardo' }),
      thread({ id: 'c', profileName: 'Ana Maria' }),
    ];

    expect(filterThreads(rows, 'ana').map((row) => row.id)).toEqual(['a', 'c']);
  });
});

/**
 * The keyboard model, and specifically its ends. This one clamps rather than
 * wrapping: a list is not a tab strip, and being thrown from the last
 * conversation back to the first is how a rep loses their place in fifty rows.
 */
describe('nextThreadId', () => {
  const ids = ['a', 'b', 'c'];

  it('moves down and up', () => {
    expect(nextThreadId(ids, 'b', 1)).toBe('c');
    expect(nextThreadId(ids, 'b', -1)).toBe('a');
  });

  it('stops at both ends instead of wrapping', () => {
    expect(nextThreadId(ids, 'c', 1)).toBe('c');
    expect(nextThreadId(ids, 'a', -1)).toBe('a');
  });

  it('takes the first row on the way down from nothing, and the last on the way up', () => {
    expect(nextThreadId(ids, null, 1)).toBe('a');
    expect(nextThreadId(ids, null, -1)).toBe('c');
  });

  it('answers null for an empty list rather than throwing', () => {
    expect(nextThreadId([], 'a', 1)).toBeNull();
  });

  /** A selection that the current filter no longer contains starts over. */
  it('starts from the top when the selected row is not in the list', () => {
    expect(nextThreadId(ids, 'gone', 1)).toBe('a');
  });
});
