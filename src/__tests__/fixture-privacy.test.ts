import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { MetaWebhookBody } from '../domain/webhook/types';

/**
 * Asserts that nothing identifying survives from a raw capture into its
 * committed fixture.
 *
 * This exists because ad-hoc scanning found five separate leaks in one
 * afternoon — `user_id`, `from_user_id`, `recipient_user_id`, an inlined media
 * URL with an access token, and a shared contact card carrying a third party's
 * name, three phone numbers and a base64 vCard repeating all of it. The fifth
 * was a *regression I introduced while fixing the fourth*: an early return
 * short-circuited WAMID redaction, and every WAMID base64-embeds the contact's
 * phone number.
 *
 * Redaction rules will keep changing as new payload types are captured, so the
 * check belongs in the suite rather than in someone's memory. It compares each
 * committed fixture against its raw original, so it needs no hardcoded list of
 * secrets — it derives them from the source every run.
 *
 * Skips when `raw/` is absent (clean checkout, CI); hard gate wherever captures
 * exist.
 */

const FIXTURE_DIR = join(process.cwd(), 'src/__tests__/fixtures/meta');
const RAW_DIR = join(FIXTURE_DIR, 'raw');

const PHONE_KEYS = new Set([
  'wa_id',
  'from',
  'recipient_id',
  'display_phone_number',
  'phone_number',
  'phone',
  'message_template_button_phone_number',
]);

const NAME_KEYS = new Set([
  'name',
  'first_name',
  'last_name',
  'formatted_name',
  'middle_name',
  'prefix',
  'suffix',
]);

const digitsOf = (value: string) => value.replace(/\D/g, '');

/** WAMIDs embed the contact's phone number as base64 between `HBgM` and `FQ`. */
const phoneInsideWamid = (wamid: string): string | null => {
  const match = /^wamid\.HBgM([A-Za-z0-9+/=]+?)FQ/.exec(wamid);
  if (match === null) return null;
  try {
    return Buffer.from(`${match[1]}==`, 'base64').toString('utf8');
  } catch {
    return null;
  }
};

const collectIdentifiers = (payload: unknown): Set<string> => {
  const found = new Set<string>();

  const add = (value: string) => {
    if (value.length >= 6) found.add(value);
  };

  const walk = (node: unknown, key?: string): void => {
    if (typeof node === 'string') {
      if (key !== undefined && PHONE_KEYS.has(key) && digitsOf(node).length >= 6) {
        add(node);
        add(digitsOf(node));
      }
      if (key !== undefined && NAME_KEYS.has(key) && !node.startsWith('Test Contact')) {
        add(node);
      }
      if (/^[A-Z]{2}\.\d{10,}$/.test(node)) add(node);
      if (node.includes('fbsbx.com')) add(node);
      if (node.startsWith('wamid.')) {
        add(node);
        const embedded = phoneInsideWamid(node);
        if (embedded !== null && /^\d{6,}$/.test(embedded)) add(embedded);
      }
      if (key === 'vcard') {
        try {
          for (const line of Buffer.from(node, 'base64').toString('utf8').split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length > 0) add(trimmed);
          }
        } catch {
          /* not base64 — nothing to extract */
        }
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }

    if (node !== null && typeof node === 'object') {
      for (const [childKey, childValue] of Object.entries(node)) walk(childValue, childKey);
    }
  };

  walk(payload);
  return found;
};

type Pair = { name: string; original: MetaWebhookBody; committed: string };

const loadPairs = (): Pair[] => {
  if (!existsSync(RAW_DIR)) return [];

  return readdirSync(RAW_DIR)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const committedPath = join(FIXTURE_DIR, name);
      if (!existsSync(committedPath)) return [];

      const raw = JSON.parse(readFileSync(join(RAW_DIR, name), 'utf8')) as {
        rawBodyBase64: string;
      };

      return [
        {
          name,
          original: JSON.parse(
            Buffer.from(raw.rawBodyBase64, 'base64').toString('utf8'),
          ) as MetaWebhookBody,
          committed: readFileSync(committedPath, 'utf8'),
        },
      ];
    });
};

const pairs = loadPairs();

describe.skipIf(pairs.length === 0)('committed fixtures leak nothing from their raw original', () => {
  it.each(pairs.map((p) => [p.name, p] as const))('%s', (_name, pair) => {
    const identifiers = [...collectIdentifiers(pair.original)];
    const leaked = identifiers.filter((value) => pair.committed.includes(value));

    expect(
      leaked,
      `${leaked.length} identifier(s) from the raw capture appear verbatim in the committed ` +
        `fixture. Extend src/domain/webhook/redact.ts and run \`yarn capture:reredact\`. ` +
        `Leaked: ${leaked.map((v) => v.slice(0, 40)).join(', ')}`,
    ).toEqual([]);
  });

  it('finds identifiers worth checking (guards against a vacuous pass)', () => {
    const total = pairs.reduce((sum, p) => sum + collectIdentifiers(p.original).size, 0);
    expect(total).toBeGreaterThan(pairs.length);
  });

  it('every committed fixture has a raw sibling to be checked against', () => {
    const committed = readdirSync(FIXTURE_DIR).filter(
      (n) => n.endsWith('.json') && n !== 'manifest.json',
    );
    const raw = new Set(readdirSync(RAW_DIR).filter((n) => n.endsWith('.json')));

    expect(committed.filter((n) => !raw.has(n))).toEqual([]);
  });
});

if (pairs.length === 0) {
  console.log('[fixture-privacy] skipped: no raw captures — run `yarn capture`');
}
