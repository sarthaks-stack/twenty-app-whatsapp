import { createHash } from 'node:crypto';

import type { MetaChange, MetaChangeValue, MetaMessage, MetaStatus } from './webhook/types';

/**
 * Webhook dedup keys (AR-8, specs/02 §8.1).
 *
 * `whatsappWebhookEvent.dedupKey` carries a unique index, so this function is
 * the entire duplicate-suppression mechanism for Meta's at-least-once delivery:
 * a retried POST must produce the *same* key, and a genuinely new event must
 * produce a different one. Getting the first wrong duplicates conversations;
 * getting the second wrong silently discards real events (D-12).
 *
 * Two deviations from the spec table, both deliberate and both fixing a defect
 * the table would have shipped:
 *
 *  1. **A change can hold many items.** The table gives per-item keys
 *     (`msg:{wamid}`), but specs/03 §3 writes one row per `changes[]` element,
 *     and Meta batches statuses freely — the two are only consistent when a
 *     change holds exactly one item. Single-item changes keep the readable key
 *     (`dedupKey` is the object's label identifier); multi-item changes get a
 *     digest over their ordered item keys. Per-item idempotency is not lost —
 *     it is enforced downstream, where it belongs: `wa-inbound-processor`
 *     checks `messageExists(wamid)` and `advanceStatus` is monotonic.
 *
 *  2. **Account and template events fold in `entry.time`.** The table hashes
 *     only the change value, which collapses a phone number that oscillates
 *     GREEN → YELLOW → GREEN → YELLOW into two rows and drops the rest as
 *     duplicates. Meta's retries replay the identical body, `entry.time`
 *     included, so including it costs nothing and keeps genuine repeats
 *     distinct. It is required for another reason too: template and account
 *     payloads carry no timestamp of their own — verified against Meta's own
 *     dashboard samples, where `account_review_update` is the single field
 *     `{ decision: 'APPROVED' }` and nothing else.
 */

export type DedupKeyInput = {
  entryId: string | undefined;
  /** `entry.time`, epoch seconds. Meta puts it on the entry, never the value. */
  entryTime: number | undefined;
  change: MetaChange;
};

const hash = (value: string, length: number): string =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, length);

/**
 * Key-order-independent JSON. Meta replays retries byte-for-byte, so sorting is
 * insurance rather than a requirement — but it is the difference between a
 * hash that is stable by observation and one that is stable by construction.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);

  return `{${entries.join(',')}}`;
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';

const messageKey = (message: MetaMessage): string => `msg:${message.id ?? 'unknown'}`;

/**
 * The status is part of the key on purpose: the legitimate
 * `sent → delivered → read` sequence for one WAMID must produce three rows,
 * while a redelivery of any one of them produces none (AR-8).
 *
 * `failed` additionally folds in the error code, because Meta can emit more
 * than one distinct failure for a message — a rate-limit failure followed by a
 * policy failure are different events, not a duplicate.
 */
const statusKey = (status: MetaStatus): string => {
  const base = `st:${status.id ?? 'unknown'}:${slug(status.status ?? 'unknown')}`;
  const code = status.errors?.[0]?.code;

  return status.status === 'failed' && code !== undefined ? `${base}:${code}` : base;
};

const templateKey = (
  field: string,
  value: MetaChangeValue,
  entryTime: number | undefined,
): string => {
  const id = value.message_template_id ?? 'unknown';
  const time = entryTime ?? 0;

  switch (field) {
    case 'message_template_status_update':
      return `tpl:${id}:status:${slug(value.event ?? 'unknown')}:${time}`;
    case 'message_template_quality_update':
      return `tpl:${id}:quality:${slug(value.new_quality_score ?? 'unknown')}:${time}`;
    default:
      // components_update has no discriminator but its content; two distinct
      // component edits inside one second are implausible, the hash is cheap.
      return `tpl:${id}:components:${time}:${hash(canonicalJson(value), 8)}`;
  }
};

const accountKey = (
  field: string,
  value: MetaChangeValue,
  entryId: string | undefined,
  entryTime: number | undefined,
): string => {
  const routingId = value.metadata?.phone_number_id ?? entryId ?? 'unknown';

  return `acct:${routingId}:${field}:${hash(`${entryTime ?? 0}|${canonicalJson(value)}`, 16)}`;
};

const ACCOUNT_FIELDS = new Set([
  'account_update',
  'account_review_update',
  'phone_number_quality_update',
  'phone_number_name_update',
]);

const TEMPLATE_FIELDS = new Set([
  'message_template_status_update',
  'message_template_quality_update',
  'message_template_components_update',
]);

/**
 * Every dedup key a change contains, in a stable order. Exported because it is
 * the readable form: a processor logging "which item am I on" and the ingest
 * tests both want the per-item keys, not the digest.
 */
export const buildItemDedupKeys = ({ entryId, entryTime, change }: DedupKeyInput): string[] => {
  const field = change.field ?? 'unknown';
  const value = change.value ?? {};
  const keys: string[] = [];

  for (const message of value.messages ?? []) keys.push(messageKey(message));
  for (const status of value.statuses ?? []) keys.push(statusKey(status));

  if (keys.length === 0 && (value.errors ?? []).length > 0) {
    keys.push(
      `acct-err:${value.metadata?.phone_number_id ?? entryId ?? 'unknown'}:${
        value.errors?.[0]?.code ?? 'unknown'
      }:${entryTime ?? 0}`,
    );
  }

  if (keys.length > 0) return keys;

  if (TEMPLATE_FIELDS.has(field)) return [templateKey(field, value, entryTime)];
  if (ACCOUNT_FIELDS.has(field)) return [accountKey(field, value, entryId, entryTime)];

  return [`raw:${hash(`${field}|${entryTime ?? 0}|${canonicalJson(value)}`, 32)}`];
};

/**
 * The single key stored on the `whatsappWebhookEvent` row for this change.
 */
export const buildDedupKey = (input: DedupKeyInput): string => {
  const keys = buildItemDedupKeys(input);

  return keys.length === 1 ? keys[0]! : `multi:${hash(keys.join('|'), 32)}`;
};
