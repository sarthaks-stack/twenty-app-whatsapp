/**
 * Regenerates every committed fixture from its gitignored raw sibling.
 *
 * Run after changing the redaction rules — otherwise fixtures captured under
 * the old rules keep whatever the old rules missed. Real payloads carry fields
 * Meta's documentation never shows (`user_id`, `from_user_id`, inlined media
 * URLs), so the rules will change again.
 *
 *   yarn capture:reredact
 */

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { classifyChange } from '../../src/domain/webhook/classify-change.ts';
import { redactWebhookPayload } from '../../src/domain/webhook/redact.ts';
import { isMetaSampleDelivery } from '../../src/domain/webhook/sample-delivery.ts';
import type { MetaWebhookBody } from '../../src/domain/webhook/types.ts';

const FIXTURE_DIR = join(process.cwd(), 'src/__tests__/fixtures/meta');
const RAW_DIR = join(FIXTURE_DIR, 'raw');

if (!existsSync(RAW_DIR)) {
  console.error('No raw/ directory — nothing to regenerate.');
  process.exit(1);
}

const files = readdirSync(RAW_DIR).filter((name) => name.endsWith('.json'));
let rewritten = 0;

/** Rebuilt from scratch: slugs change when the classifier is corrected. */
const captured: Record<string, { count: number; firstSeenAt: string; files: string[] }> = {};

for (const name of files) {
  const raw = JSON.parse(readFileSync(join(RAW_DIR, name), 'utf8')) as {
    capturedAt: string;
    rawBodyBase64: string;
  };

  const body = JSON.parse(
    Buffer.from(raw.rawBodyBase64, 'base64').toString('utf8'),
  ) as MetaWebhookBody;

  const classifications = (body.entry ?? [])
    .flatMap((entry) => entry.changes ?? [])
    .map(classifyChange);
  const isSample = isMetaSampleDelivery(body);
  const classified = classifications.flatMap((cl) => cl.slugs);
  const slugs = isSample
    ? (classified.length > 0 ? classified : ['unknown']).map((slug) => `sample-${slug}`)
    : classified;

  // Keep the filename in step with the slug: a corrected classifier otherwise
  // leaves files named after the old, wrong slug.
  const parts = name.split('--');
  const stamp = parts[parts.length - 1] ?? name;
  const desiredName = `${slugs[0] ?? 'unknown'}--${stamp}`;
  if (desiredName !== name) {
    renameSync(join(RAW_DIR, name), join(RAW_DIR, desiredName));
    if (existsSync(join(FIXTURE_DIR, name))) {
      renameSync(join(FIXTURE_DIR, name), join(FIXTURE_DIR, desiredName));
    }
  }

  const existingPath = join(FIXTURE_DIR, desiredName);
  const existingHeaders = existsSync(existingPath)
    ? ((JSON.parse(readFileSync(existingPath, 'utf8')) as { headers?: unknown }).headers ?? {})
    : {};

  const { redacted } = redactWebhookPayload(body);

  writeFileSync(
    existingPath,
    `${JSON.stringify(
      {
        capturedAt: raw.capturedAt,
        synthetic: false,
        isMetaDashboardSample: isSample,
        note: isSample
          ? "Meta's dashboard Test payload. Genuinely signed, but the wamid, phone_number_id " +
            'and timestamp are fabricated — do not use as a message fixture.'
          : undefined,
        slugs,
        fields: classifications.map((cl) => cl.field),
        kinds: [...new Set(classifications.flatMap((cl) => cl.kinds))],
        headers: existingHeaders,
        body: redacted,
      },
      null,
      2,
    )}\n`,
  );

  if (!isSample) {
    for (const slug of slugs) {
      const entry = captured[slug] ?? { count: 0, firstSeenAt: raw.capturedAt, files: [] };
      entry.count += 1;
      if (raw.capturedAt < entry.firstSeenAt) entry.firstSeenAt = raw.capturedAt;
      if (!entry.files.includes(desiredName)) entry.files.push(desiredName);
      captured[slug] = entry;
    }
  }

  rewritten += 1;
  console.log(`  ${desiredName.padEnd(62)} ${slugs.join(' + ')}`);
}

writeFileSync(
  join(FIXTURE_DIR, 'manifest.json'),
  `${JSON.stringify(
    { updatedAt: new Date().toISOString(), deliveries: files.length, captured },
    null,
    2,
  )}\n`,
);

console.log(`\nRegenerated ${rewritten} fixture(s) and rebuilt the manifest from raw bytes.`);
