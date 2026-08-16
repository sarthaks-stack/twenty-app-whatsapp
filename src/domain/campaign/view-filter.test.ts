import { describe, expect, it } from 'vitest';

import {
  escapeLike,
  parseValue,
  translateFilter,
  translateViewFilters,
  VIEW_FILTER_OPERAND,
  type FieldDescriptor,
  type ViewFilterRow,
} from './view-filter';

/**
 * The audience is who receives a marketing message, so a filter translated
 * *nearly* correctly is worse than one refused outright: it sends to people the
 * admin did not choose, and nothing about the result looks wrong. These tests
 * exist to pin the exact comparator for every pair, and — just as importantly —
 * to pin what is refused.
 */

const NOW = new Date('2026-08-16T09:30:00.000Z');

const field = (name: string, type: string): FieldDescriptor => ({ name, type });

const row = (overrides: Partial<ViewFilterRow> = {}): ViewFilterRow => ({
  id: 'f1',
  fieldMetadataId: 'field-1',
  operand: VIEW_FILTER_OPERAND.IS,
  value: null,
  viewFilterGroupId: null,
  positionInViewFilterGroup: 0,
  subFieldName: null,
  ...overrides,
});

describe('parseValue', () => {
  it('parses a JSON array', () => {
    expect(parseValue('["OPTED_IN","UNKNOWN"]')).toEqual(['OPTED_IN', 'UNKNOWN']);
  });

  it('leaves a plain string alone', () => {
    expect(parseValue('Luanda')).toBe('Luanda');
  });

  /** A text filter may legitimately start with `[`; a parse failure is data. */
  it('returns malformed JSON as the original string', () => {
    expect(parseValue('[not json')).toBe('[not json');
  });

  it('passes an already-parsed value through', () => {
    expect(parseValue(['A'])).toEqual(['A']);
  });
});

describe('escapeLike', () => {
  it('escapes the wildcards so a literal search stays literal', () => {
    expect(escapeLike('50%_off')).toBe('50\\%\\_off');
  });
});

describe('text filters', () => {
  it('translates CONTAINS to a case-insensitive wildcard match', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'CONTAINS', value: 'Luanda' }),
        field: field('city', 'TEXT'),
        now: NOW,
      }),
    ).toEqual({ city: { ilike: '%Luanda%' } });
  });

  it('translates DOES_NOT_CONTAIN as a negation of the same match', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'DOES_NOT_CONTAIN', value: 'test' }),
        field: field('jobTitle', 'TEXT'),
        now: NOW,
      }),
    ).toEqual({ not: { jobTitle: { ilike: '%test%' } } });
  });

  /**
   * Twenty writes `''` into a cleared text column rather than null, so a
   * null-only test would report a blank field as filled — and put someone in an
   * audience the filter meant to exclude.
   */
  it('treats an empty string as empty, not merely null', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'IS_EMPTY' }),
        field: field('city', 'TEXT'),
        now: NOW,
      }),
    ).toEqual({ or: [{ city: { is: 'NULL' } }, { city: { eq: '' } }] });
  });

  /**
   * A filter on "Name" with no sub-field means either name, which is what the
   * UI showed the admin. Translating it to `firstName` alone would silently
   * halve the audience.
   */
  it('fans a bare composite filter across the sub-fields the UI searches', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'CONTAINS', value: 'Silva' }),
        field: field('name', 'FULL_NAME'),
        now: NOW,
      }),
    ).toEqual({
      or: [
        { name: { firstName: { ilike: '%Silva%' } } },
        { name: { lastName: { ilike: '%Silva%' } } },
      ],
    });
  });

  it('honours an explicit sub-field', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'CONTAINS', value: 'Silva', subFieldName: 'lastName' }),
        field: field('name', 'FULL_NAME'),
        now: NOW,
      }),
    ).toEqual({ name: { lastName: { ilike: '%Silva%' } } });
  });
});

describe('select filters', () => {
  it('translates IS over several options to an in-list', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'IS', value: '["OPTED_IN","UNKNOWN"]' }),
        field: field('whatsappOptInStatus', 'SELECT'),
        now: NOW,
      }),
    ).toEqual({ whatsappOptInStatus: { in: ['OPTED_IN', 'UNKNOWN'] } });
  });

  it('translates IS_NOT as a negated in-list', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'IS_NOT', value: '["OPTED_OUT"]' }),
        field: field('whatsappOptInStatus', 'SELECT'),
        now: NOW,
      }),
    ).toEqual({ not: { whatsappOptInStatus: { in: ['OPTED_OUT'] } } });
  });

  /** An empty option list is a filter that means nothing — and would match all. */
  it('refuses a select filter with no options chosen', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'IS', value: '[]' }),
        field: field('whatsappOptInStatus', 'SELECT'),
        now: NOW,
      }),
    ).toContain('no options selected');
  });
});

describe('multi-select filters', () => {
  it('uses containsAny rather than in', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'IS', value: '["VIP"]' }),
        field: field('tags', 'MULTI_SELECT'),
        now: NOW,
      }),
    ).toEqual({ tags: { containsAny: ['VIP'] } });
  });
});

describe('date filters', () => {
  /**
   * A column storing 14:32 never equals a filter written as midnight, so an
   * exact comparison would produce an empty audience that looks like a data
   * problem rather than a translation one.
   */
  it('reads IS on a date as the whole day', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'IS', value: '2026-03-04T11:00:00.000Z' }),
        field: field('createdAt', 'DATE_TIME'),
        now: NOW,
      }),
    ).toEqual({
      createdAt: { gte: '2026-03-04T00:00:00.000Z', lt: '2026-03-05T00:00:00.000Z' },
    });
  });

  it('resolves IS_TODAY against the injected clock', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'IS_TODAY' }),
        field: field('createdAt', 'DATE_TIME'),
        now: NOW,
      }),
    ).toEqual({
      createdAt: { gte: '2026-08-16T00:00:00.000Z', lt: '2026-08-17T00:00:00.000Z' },
    });
  });

  it('translates IS_BEFORE and IS_AFTER', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'IS_BEFORE', value: '2026-01-01T00:00:00.000Z' }),
        field: field('createdAt', 'DATE_TIME'),
        now: NOW,
      }),
    ).toEqual({ createdAt: { lt: '2026-01-01T00:00:00.000Z' } });
  });

  /**
   * The deliberate gap. "This month" and "the last 30 days" have calendar
   * boundaries whose interpretation we would be guessing at, and guessing wrong
   * sends to the wrong several hundred people. Refusing names the filter and
   * offers the admin an exact alternative.
   */
  it('refuses a relative date range by name', () => {
    const refusal = translateFilter({
      filter: row({ operand: 'IS_RELATIVE', value: '{"direction":"PAST","amount":30,"unit":"DAY"}' }),
      field: field('createdAt', 'DATE_TIME'),
      now: NOW,
    });

    expect(refusal).toContain('relative date ranges are not translated');
  });
});

describe('refusals', () => {
  it('refuses a full-text search as an audience definition', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'VECTOR_SEARCH', value: 'anything' }),
        field: field('searchVector', 'TS_VECTOR'),
        now: NOW,
      }),
    ).toContain('full-text search cannot define an audience');
  });

  it('refuses a field type it has no comparator for', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'IS', value: 'x' }),
        field: field('avatarFile', 'RAW_JSON'),
        now: NOW,
      }),
    ).toContain('cannot be translated');
  });

  it('refuses a numeric filter whose value is not a number', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'GREATER_THAN_OR_EQUAL', value: 'many' }),
        field: field('position', 'NUMBER'),
        now: NOW,
      }),
    ).toContain('is not a number');
  });

  /**
   * D-35. `Number(null)` and `Number('')` are 0 — a perfectly finite number —
   * so a numeric filter left blank translated into `= 0` and selected a
   * different set of people, with nothing about the result looking wrong.
   */
  it.each([null, '', '   '])('refuses a numeric filter whose value is %p', (value) => {
    expect(
      translateFilter({
        filter: row({ operand: 'IS', value }),
        field: field('position', 'NUMBER'),
        now: NOW,
      }),
    ).toContain('is not a number');
  });

  it('still accepts a genuine zero', () => {
    expect(
      translateFilter({
        filter: row({ operand: 'IS', value: '0' }),
        field: field('position', 'NUMBER'),
        now: NOW,
      }),
    ).toEqual({ position: { eq: 0 } });
  });
});

describe('translateViewFilters', () => {
  const fields = new Map<string, FieldDescriptor>([
    ['field-city', field('city', 'TEXT')],
    ['field-consent', field('whatsappOptInStatus', 'SELECT')],
  ]);

  it('ANDs top-level filters', () => {
    const result = translateViewFilters({
      filters: [
        row({ id: 'a', fieldMetadataId: 'field-city', operand: 'CONTAINS', value: 'Luanda' }),
        row({
          id: 'b',
          fieldMetadataId: 'field-consent',
          operand: 'IS',
          value: '["OPTED_IN"]',
          positionInViewFilterGroup: 1,
        }),
      ],
      groups: [],
      fields,
      now: NOW,
    });

    expect(result).toEqual({
      ok: true,
      filter: {
        and: [
          { city: { ilike: '%Luanda%' } },
          { whatsappOptInStatus: { in: ['OPTED_IN'] } },
        ],
      },
    });
  });

  it('applies a group’s logical operator', () => {
    const result = translateViewFilters({
      filters: [
        row({ id: 'a', fieldMetadataId: 'field-city', operand: 'CONTAINS', value: 'Luanda', viewFilterGroupId: 'g1' }),
        row({ id: 'b', fieldMetadataId: 'field-city', operand: 'CONTAINS', value: 'Benguela', viewFilterGroupId: 'g1', positionInViewFilterGroup: 1 }),
      ],
      groups: [{ id: 'g1', logicalOperator: 'OR', parentViewFilterGroupId: null }],
      fields,
      now: NOW,
    });

    expect(result).toEqual({
      ok: true,
      filter: { or: [{ city: { ilike: '%Luanda%' } }, { city: { ilike: '%Benguela%' } }] },
    });
  });

  it('collapses a single condition rather than wrapping it', () => {
    const result = translateViewFilters({
      filters: [row({ fieldMetadataId: 'field-city', operand: 'CONTAINS', value: 'Luanda' })],
      groups: [],
      fields,
      now: NOW,
    });

    expect(result).toEqual({ ok: true, filter: { city: { ilike: '%Luanda%' } } });
  });

  it('answers an unfiltered view with no filter at all', () => {
    expect(translateViewFilters({ filters: [], groups: [], fields, now: NOW })).toEqual({
      ok: true,
      filter: null,
    });
  });

  /**
   * The whole point of the module. One untranslatable filter refuses the whole
   * view — a partially applied filter set is a wider audience than the admin
   * chose, and widening is the direction that messages strangers.
   */
  it('refuses the whole view when one filter cannot be translated', () => {
    const result = translateViewFilters({
      filters: [
        row({ id: 'a', fieldMetadataId: 'field-city', operand: 'CONTAINS', value: 'Luanda' }),
        row({ id: 'b', fieldMetadataId: 'field-consent', operand: 'IS_RELATIVE', value: '{}' }),
      ],
      groups: [],
      fields,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasons).toHaveLength(1);
  });

  it('refuses a filter naming a field it cannot see', () => {
    const result = translateViewFilters({
      filters: [row({ fieldMetadataId: 'field-unknown', operand: 'IS', value: 'x' })],
      groups: [],
      fields,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasons[0]).toContain('cannot see');
  });

  /** `NOT` never appears in the UI, and treating it as `AND` would invert. */
  it('refuses a NOT group', () => {
    const result = translateViewFilters({
      filters: [row({ fieldMetadataId: 'field-city', operand: 'CONTAINS', value: 'x', viewFilterGroupId: 'g1' })],
      groups: [{ id: 'g1', logicalOperator: 'NOT', parentViewFilterGroupId: null }],
      fields,
      now: NOW,
    });

    expect(result.ok).toBe(false);
  });

  /** A cyclic parent reference must fail, not hang. */
  /**
   * D-40. This used to answer `{ ok: true, filter: null }` — the two groups
   * were simply never reached, and a view that translates to *no filter* is an
   * audience of every contact in the CRM. Unreachable is refused, not ignored.
   */
  it('refuses groups that refer to each other', () => {
    const result = translateViewFilters({
      filters: [],
      groups: [
        { id: 'g1', logicalOperator: 'AND', parentViewFilterGroupId: 'g2' },
        { id: 'g2', logicalOperator: 'AND', parentViewFilterGroupId: 'g1' },
      ],
      fields,
      now: NOW,
      maxDepth: 3,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasons.join(' ')).toContain('cannot be reached');
  });

  it('refuses a filter whose group no longer exists', () => {
    const result = translateViewFilters({
      filters: [
        row({
          id: 'f1',
          fieldMetadataId: 'field-city',
          operand: 'CONTAINS',
          value: 'Ana',
          viewFilterGroupId: 'gone',
        }),
      ],
      groups: [],
      fields,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasons.join(' ')).toContain('cannot be reached');
  });

  it('says nothing about a view whose groups all hang off the root', () => {
    const result = translateViewFilters({
      filters: [
        row({ id: 'f1', fieldMetadataId: 'field-city', operand: 'CONTAINS', value: 'Ana' }),
        row({
          id: 'f2',
          fieldMetadataId: 'field-city',
          operand: 'CONTAINS',
          value: 'Luanda',
          viewFilterGroupId: 'g1',
        }),
      ],
      groups: [{ id: 'g1', logicalOperator: 'OR', parentViewFilterGroupId: null }],
      fields,
      now: NOW,
    });

    expect(result.ok).toBe(true);
  });
});
