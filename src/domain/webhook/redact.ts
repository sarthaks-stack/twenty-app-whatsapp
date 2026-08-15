import { createHash } from 'node:crypto';

/**
 * Pseudonymises a captured Meta payload so it can be committed as a test
 * fixture (specs/12-testing.md §4 — "recorded real payloads, redacted phone
 * numbers").
 *
 * Redaction is **deterministic**: the same input always maps to the same
 * pseudonym, within and across capture sessions. Without that, `contacts[].wa_id`
 * and `messages[].from` would stop agreeing and the matching tests would be
 * exercising an impossible payload.
 *
 * The redacted copy is what gets committed. The exact bytes and the real Meta
 * signature stay in the gitignored `raw/` sibling directory, because a
 * body+signature pair is an oracle for the App Secret.
 */

const PHONE_KEYS = new Set([
  'display_phone_number',
  'wa_id',
  'from',
  'recipient_id',
  'input',
  // account_update uses `phone_number`, not `display_phone_number`.
  'phone_number',
  // Shared contact cards: contacts[].phones[].phone, often with spaces.
  'phone',
  'message_template_button_phone_number',
]);

/** NOT phone numbers despite being all digits — redacting these breaks routing tests. */
const NEVER_PHONE_KEYS = new Set(['phone_number_id', 'id', 'timestamp']);

/**
 * A shared contact card carries a **third party's** name — someone who never
 * messaged the business and never consented to anything. Found in a real
 * `contacts` capture on 2026-08-15.
 */
const NAME_KEYS = new Set(['first_name', 'last_name', 'formatted_name', 'middle_name', 'suffix', 'prefix']);

/**
 * The same card repeats every name and number inside a base64 vCard, so
 * redacting the structured fields alone leaves the PII fully recoverable.
 * Decoding and rewriting it is not worth the complexity: it is replaced whole.
 */
const REDACTED_VCARD = Buffer.from(
  'BEGIN:VCARD\nVERSION:3.0\nN:Contact;Test;;;\nFN:Test Contact\nTEL:+244900000000\nEND:VCARD',
  'utf8',
).toString('base64');

/** Tolerates the spacing real cards use: `+244 914 856 260`. */
const PHONE_SHAPE = /^\+?[\d\s().-]{6,}$/;
const digitsOf = (value: string): string => value.replace(/\D/g, '');

/**
 * Meta's stable per-user identifier (`US.13491208655302741918`), present on real
 * deliveries as `contacts[].user_id` and `messages[].from_user_id`. It is not a
 * phone number, but it identifies the contact across conversations just as
 * durably — so it is pseudonymised too. Absent from Meta's documented samples;
 * found only by capturing a real message.
 */
const USER_ID_KEYS = new Set(['user_id', 'from_user_id', 'recipient_user_id']);

/**
 * Belt and braces. Three different keys were found carrying this identifier
 * (`user_id`, `from_user_id`, `recipient_user_id`), each discovered by a
 * separate leak scan after a new payload type was captured. Matching the value
 * shape as well as the key name means the fourth variant — whatever Meta calls
 * it — is redacted the first time it appears rather than the first time someone
 * notices.
 */
const USER_ID_VALUE_PATTERN = /^[A-Z]{2}\.\d{10,}$/;

/**
 * The two-letter prefix is region-derived, not a constant: Meta's documented
 * sample shows `US.…`, a real Angolan contact arrives as `AO.…`. Matching the
 * literal `US.` silently passed real identifiers straight through — caught by
 * scanning committed fixtures, not by any hand-written test.
 */
const USER_ID_PATTERN = /^([A-Z]{2}\.)?(.+)$/;

const WAMID_PREFIX = 'wamid.';

/**
 * Real inbound media payloads inline a lookaside CDN URL carrying `mid` and a
 * `hash` access token. It expires in minutes and still needs the bearer token,
 * so it is not much of a secret — but it is account-identifying and has no
 * business in a committed fixture. The shape is preserved so parsers can still
 * be exercised.
 */
const MEDIA_URL_PATTERN = /^https:\/\/[a-z0-9.-]*fbsbx\.com\//i;

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Maps a real number to a stable pseudonym in the Angolan +244 9xx range, so
 * fixtures stay realistic for the libphonenumber matrix (specs/05 §1).
 */
export const pseudoPhone = (real: string): string => {
  const national = (BigInt(`0x${digest(real).slice(0, 12)}`) % 100_000_000n)
    .toString()
    .padStart(8, '0');

  return `2449${national}`;
};

export const pseudoWamid = (real: string): string => {
  const body = Buffer.from(digest(real), 'hex')
    .toString('base64url')
    .slice(0, 32)
    .toUpperCase();

  return `${WAMID_PREFIX}${body}`;
};

export const pseudoName = (real: string): string =>
  `Test Contact ${digest(real).slice(0, 4).toUpperCase()}`;

export const pseudoUserId = (real: string): string => {
  const prefix = USER_ID_PATTERN.exec(real)?.[1] ?? '';
  const digits = (BigInt(`0x${digest(real).slice(0, 16)}`) % 10_000_000_000_000_000n)
    .toString()
    .padStart(16, '0');

  return `${prefix}${digits}`;
};

/** Keeps the host and `mid` shape, drops the access token and every other query parameter. */
export const scrubMediaUrl = (real: string): string => {
  try {
    const url = new URL(real);
    const mid = url.searchParams.get('mid');
    return `${url.origin}${url.pathname}${mid === null ? '' : `?mid=${mid}`}`;
  } catch {
    return '<redacted-media-url>';
  }
};

type RedactionState = { phones: Map<string, string> };

const redactString = (
  key: string,
  value: string,
  parentKey: string | undefined,
  state: RedactionState,
): string => {
  // Suppresses only the phone branch. Returning early here short-circuited the
  // wamid rule for `messages[].id` and `context.id`, and every WAMID
  // base64-embeds the contact's phone number — caught by re-running the leak
  // scan after the change, not by any test.
  if (
    !NEVER_PHONE_KEYS.has(key) &&
    PHONE_KEYS.has(key) &&
    PHONE_SHAPE.test(value) &&
    digitsOf(value).length >= 6
  ) {
    // Pseudonymise the digit-normalised form so `+244 914 856 260` and
    // `+244914856260` map to the same replacement.
    const digits = digitsOf(value);
    const replacement = (value.trimStart().startsWith('+') ? '+' : '') + pseudoPhone(digits);
    state.phones.set(value, replacement);
    state.phones.set(digits, replacement);
    state.phones.set(`+${digits}`, replacement);
    return replacement;
  }

  if (key === 'vcard') return REDACTED_VCARD;

  if (NAME_KEYS.has(key)) return pseudoName(value);

  if (
    (USER_ID_KEYS.has(key) && value.length > 0) ||
    USER_ID_VALUE_PATTERN.test(value)
  ) {
    return pseudoUserId(value);
  }

  if (value.startsWith(WAMID_PREFIX)) return pseudoWamid(value);

  if (key === 'url' && MEDIA_URL_PATTERN.test(value)) return scrubMediaUrl(value);

  if (key === 'name' && parentKey === 'profile') return pseudoName(value);

  return value;
};

const walk = (
  node: unknown,
  state: RedactionState,
  key: string | undefined,
  parentKey: string | undefined,
): unknown => {
  if (typeof node === 'string') {
    return key === undefined ? node : redactString(key, node, parentKey, state);
  }

  if (Array.isArray(node)) {
    return node.map((item) => walk(item, state, key, parentKey));
  }

  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(node)) {
      out[childKey] = walk(childValue, state, childKey, key);
    }
    return out;
  }

  return node;
};

/** Second pass: scrub numbers that appear inside free-text fields such as `error_data.details`. */
const scrubResiduals = (node: unknown, state: RedactionState): unknown => {
  if (typeof node === 'string') {
    let out = node;
    for (const [real, replacement] of state.phones) {
      if (real.length >= 6 && out.includes(real)) {
        out = out.split(real).join(replacement);
      }
    }
    return out;
  }

  if (Array.isArray(node)) {
    return node.map((item) => scrubResiduals(item, state));
  }

  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(node)) {
      out[childKey] = scrubResiduals(childValue, state);
    }
    return out;
  }

  return node;
};

export type RedactionResult<T> = {
  redacted: T;
  /** Real → pseudonym, for the operator to sanity-check. Never written to disk. */
  phoneMap: Map<string, string>;
};

export const redactWebhookPayload = <T>(payload: T): RedactionResult<T> => {
  const state: RedactionState = { phones: new Map() };
  const firstPass = walk(payload, state, undefined, undefined);
  const redacted = scrubResiduals(firstPass, state) as T;

  return { redacted, phoneMap: state.phones };
};
