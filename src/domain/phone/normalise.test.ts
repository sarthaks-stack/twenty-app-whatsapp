import { describe, expect, it } from 'vitest';

import { digitVariants } from './country-variants';
import { identityCandidates, splitE164, toE164, toWaId, waIdToE164 } from './normalise';

/**
 * The matrix from specs/12 §1.2. These are the cases where a silent failure
 * means a real customer's message never reaches their record — nothing throws,
 * the contact simply looks unknown.
 */
describe('toE164', () => {
  it.each([
    ['923000000', '+244', '+244923000000', 'AO national'],
    ['+244 923 000 000', '+244', '+244923000000', 'AO spaced international'],
    ['00244923000000', '+244', '+244923000000', 'AO 00 prefix'],
    ['(244) 923-000-000', '+244', '+244923000000', 'AO punctuated'],
    ['912345678', '+351', '+351912345678', 'PT national with PT default'],
    ['+351912345678', '+244', '+351912345678', 'explicit country wins over default'],
  ])('%s (default %s) → %s — %s', (input, def, expected) => {
    expect(toE164(input, def)).toBe(expected);
  });

  it.each([
    ['abc', 'letters'],
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['+1555', 'too short'],
    ['+2449230000000000', 'too long'],
  ])('rejects %s (%s)', (input) => {
    expect(toE164(input)).toBeNull();
  });

  it.each<[string, string | null | undefined]>([
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, input) => {
    expect(toE164(input)).toBeNull();
  });

  it('defaults to Angola when no calling code is supplied', () => {
    expect(toE164('923000000')).toBe('+244923000000');
  });
});

describe('waIdToE164', () => {
  it('adds the plus and validates', () => {
    expect(waIdToE164('244923000000')).toBe('+244923000000');
  });

  /**
   * The pre-9th-digit Brazilian form is a *valid* landline number, so it
   * canonicalises to itself rather than being "corrected". Reaching the mobile
   * form is `identityCandidates`' job, not this function's — conflating the two
   * would silently rewrite a landline into a different subscriber's number.
   */
  it('canonicalises a Brazilian 8-digit form to itself', () => {
    expect(waIdToE164('551187654321')).toBe('+551187654321');
  });

  /**
   * Mexico's legacy `521` prefix is the one variant libphonenumber rejects
   * outright, and is what the recovery path exists for: without it a wa_id in
   * that form resolves to null and the contact looks unknown.
   */
  it('recovers the Mexican 521 form, which is invalid as dialled', () => {
    expect(waIdToE164('5215512345678')).toBe('+525512345678');
  });

  it.each([[''], ['12'], ['abc']])('rejects %s', (input) => {
    expect(waIdToE164(input)).toBeNull();
  });
});

describe('identityCandidates', () => {
  it('returns a single candidate for a market with no variants', () => {
    expect(identityCandidates('+244923000000')).toEqual(['+244923000000']);
  });

  it('generates the Brazilian 9th-digit pair in both directions', () => {
    expect(identityCandidates('+5511987654321')).toEqual(
      expect.arrayContaining(['+5511987654321', '+551187654321']),
    );
    expect(identityCandidates('+551187654321')).toEqual(
      expect.arrayContaining(['+551187654321', '+5511987654321']),
    );
  });

  it('generates the Argentine 9-infix pair in both directions', () => {
    expect(identityCandidates('+5491123456789')).toEqual(
      expect.arrayContaining(['+5491123456789', '+541123456789']),
    );
    expect(identityCandidates('+541123456789')).toEqual(
      expect.arrayContaining(['+541123456789', '+5491123456789']),
    );
  });

  it('generates the Mexican 1-prefix pair in both directions', () => {
    expect(identityCandidates('+5215512345678')).toEqual(
      expect.arrayContaining(['+5215512345678', '+525512345678']),
    );
    expect(identityCandidates('+525512345678')).toEqual(
      expect.arrayContaining(['+525512345678', '+5215512345678']),
    );
  });

  it('always includes the input', () => {
    for (const n of ['+244923000000', '+5511987654321', '+541123456789', '+5215512345678']) {
      expect(identityCandidates(n)).toContain(n);
    }
  });

  it('never returns duplicates', () => {
    for (const n of ['+244923000000', '+5511987654321', '+5491123456789']) {
      const c = identityCandidates(n);
      expect(c.length).toBe(new Set(c).size);
    }
  });

  it('is symmetric: each candidate regenerates the original', () => {
    for (const n of ['+5511987654321', '+5491123456789', '+5215512345678']) {
      for (const candidate of identityCandidates(n)) {
        expect(identityCandidates(candidate)).toContain(n);
      }
    }
  });

  it.each([[''], [null], [undefined], ['+1']])('returns empty for %s', (input) => {
    expect(identityCandidates(input)).toEqual([]);
  });
});

describe('digitVariants', () => {
  it('does not invent variants for a short or unknown prefix', () => {
    expect(digitVariants('244923000000')).toEqual(['244923000000']);
    expect(digitVariants('5511')).toEqual(['5511']);
  });
});

describe('splitE164', () => {
  it('splits into the parts Twenty’s PHONES composite needs', () => {
    expect(splitE164('+244923000000')).toEqual({
      callingCode: '+244',
      nationalNumber: '923000000',
      countryCode: 'AO',
    });
  });

  it('returns null for an invalid number', () => {
    expect(splitE164('+1555')).toBeNull();
  });
});

describe('toWaId', () => {
  it('strips the plus, which is what Meta expects in `to`', () => {
    expect(toWaId('+244923000000')).toBe('244923000000');
  });
});
