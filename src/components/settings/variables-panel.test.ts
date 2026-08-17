import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  dirtyKeys,
  groupVariables,
  sectionOf,
  type EditableVariable,
} from './VariablesPanel';

/**
 * D-68. Twenty application variables in one undifferentiated list, each with
 * its own Save button, is a screen where nobody finds the one they came for and
 * where editing three means three round trips. The grouping and the single bar
 * replaced it; these hold the two rules that make either safe — every variable
 * lands in a section, and "what will this Save change" has one answer.
 */

const variable = (key: string, value = 'x'): EditableVariable => ({
  key,
  value,
  description: '',
  type: 'TEXT',
  options: null,
});

describe('sectionOf', () => {
  it.each([
    ['WA_SEND_THROTTLE_PER_SECOND', 'sending'],
    ['WA_INTERACTIVE_LANE_SHARE', 'sending'],
    ['WA_RECIPIENT_MIN_SPACING_MS', 'sending'],
    ['WA_SERVICE_WINDOW_HOURS', 'window'],
    ['WA_AUTO_CLOSE_DAYS', 'window'],
    ['WA_OPT_OUT_KEYWORDS', 'consent'],
    ['WA_OPT_IN_CONFIRMATION_PT', 'consent'],
    ['WA_CONFIRMATION_LOCALE', 'consent'],
    ['WA_CAMPAIGN_BATCH_SIZE', 'campaigns'],
    ['WA_TEMPLATE_SUBMIT_HOURLY_CAP', 'templates'],
    ['WA_MEDIA_AUTO_DOWNLOAD_MAX_BYTES', 'media'],
    ['WA_RETENTION_MESSAGE_MONTHS', 'retention'],
    ['WA_TIMELINE_MODE', 'retention'],
    ['WA_RATE_MARKETING_USD', 'billing'],
  ])('files %s under %s', (key, section) => {
    expect(sectionOf(key)).toBe(section);
  });

  /**
   * The fallthrough is a real section, not a silent drop. A variable added
   * tomorrow with an unfamiliar prefix must still be editable, or adding one
   * quietly removes it from the screen.
   */
  it('gives a variable with no obvious home one anyway', () => {
    expect(sectionOf('WA_SOMETHING_NOBODY_ANTICIPATED')).toBe('other');
    expect(sectionOf('COMPLETELY_UNRELATED')).toBe('other');
  });

  it.each([
    ['META_APP_ID', 'connection'],
    ['WA_PROVIDER', 'connection'],
    ['WA_POLL_INTERVAL_INBOX_MS', 'interface'],
    ['WA_ALLOW_API_KEY_ADMIN', 'access'],
    ['WA_DEFAULT_COUNTRY_CALLING_CODE', 'sending'],
  ])('files %s under %s', (key, section) => {
    expect(sectionOf(key)).toBe(section);
  });
});

/**
 * The rule that matters most: nothing disappears, and nothing is quietly
 * swept into "Other".
 *
 * The names come from `application-config.ts` — the actual declarations the
 * panel is handed — rather than from a list written here, because a list
 * written here would agree with itself for ever while the real set moved.
 */
describe('grouping the whole variable set', () => {
  const DECLARED = [
    ...readFileSync(join(process.cwd(), 'src/application-config.ts'), 'utf8').matchAll(
      /^\s{4}(WA_[A-Z0-9_]+|META_[A-Z0-9_]+):\s*\{/gm,
    ),
  ].map((match) => match[1]!);

  it('found the declarations to check', () => {
    expect(DECLARED.length).toBeGreaterThan(20);
  });

  /**
   * "Other" exists so a variable added tomorrow is still editable, not as a
   * place to leave the ones nobody grouped. Every variable that exists today
   * has a section that names what it affects.
   */
  it.each(DECLARED)('files %s under a named section', (name) => {
    expect(sectionOf(name)).not.toBe('other');
  });

  it('keeps every variable exactly once', () => {
    const input = ['WA_SEND_THROTTLE_PER_SECOND', 'WA_OPT_IN_KEYWORDS', 'WA_ODD_ONE'].map(
      (key) => variable(key),
    );

    const grouped = groupVariables(input).flatMap((group) => group.variables);

    expect(grouped.map((entry) => entry.key).sort()).toEqual(
      input.map((entry) => entry.key).sort(),
    );
  });

  it('drops sections with nothing in them', () => {
    const grouped = groupVariables([variable('WA_RATE_UTILITY_USD')]);

    expect(grouped.map((group) => group.key)).toEqual(['billing']);
  });
});

describe('dirtyKeys', () => {
  const variables = [variable('WA_A', 'one'), variable('WA_B', 'two')];

  it('finds nothing when the drafts match the server', () => {
    expect(dirtyKeys(variables, { WA_A: 'one', WA_B: 'two' })).toEqual([]);
  });

  it('names only what changed', () => {
    expect(dirtyKeys(variables, { WA_A: 'one', WA_B: 'three' })).toEqual(['WA_B']);
  });

  /** A variable nobody has touched has no draft, and is not a change. */
  it('ignores a variable with no draft at all', () => {
    expect(dirtyKeys(variables, {})).toEqual([]);
  });

  /** Emptying a value is an edit, not an absence — the route stores the empty. */
  it('counts a value cleared to empty', () => {
    expect(dirtyKeys(variables, { WA_A: '' })).toEqual(['WA_A']);
  });
});
