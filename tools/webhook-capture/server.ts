/**
 * Meta webhook capture harness.
 *
 * Purpose (specs/13-delivery-plan.md, week-1 probes P-1 and fixture capture):
 *   1. Answer probe P-1 — does Meta accept our GET handshake response?
 *   2. Record real, signed webhook deliveries as test fixtures, before any of
 *      the app exists.
 *   3. Prove the production HMAC verifier against genuine Meta signatures — it
 *      imports `verifyMetaSignature` from src/, so a green capture session *is*
 *      the conformance test.
 *
 * Deliberately standalone: no Twenty, no database, no app install. Point a
 * tunnel at it and start sending messages.
 *
 *   yarn capture
 *
 * See tools/webhook-capture/README.md for the tunnel and Meta dashboard steps.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { classifyChange } from '../../src/domain/webhook/classify-change.ts';
import { redactWebhookPayload } from '../../src/domain/webhook/redact.ts';
import { isMetaSampleDelivery } from '../../src/domain/webhook/sample-delivery.ts';
import type { MetaWebhookBody } from '../../src/domain/webhook/types.ts';
import {
  META_SIGNATURE_HEADER,
  verifyMetaSignature,
  verifyMetaVerifyToken,
} from '../../src/providers/whatsapp/verify-signature.ts';
import { REQUIRED_FIXTURES } from './required-fixtures.ts';

const PORT = Number(process.env.CAPTURE_PORT ?? 8787);
const FIXTURE_DIR = join(process.cwd(), 'src/__tests__/fixtures/meta');
const RAW_DIR = join(FIXTURE_DIR, 'raw');
const INVALID_DIR = join(RAW_DIR, 'invalid');
const MANIFEST_PATH = join(FIXTURE_DIR, 'manifest.json');

const APP_SECRET = process.env.META_APP_SECRET;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

/** Headers worth keeping. Everything else is dropped rather than filtered. */
const KEPT_HEADERS = ['content-type', 'user-agent', META_SIGNATURE_HEADER];

const c = {
  dim: (s: string) => `\u001b[2m${s}\u001b[0m`,
  green: (s: string) => `\u001b[32m${s}\u001b[0m`,
  red: (s: string) => `\u001b[31m${s}\u001b[0m`,
  yellow: (s: string) => `\u001b[33m${s}\u001b[0m`,
  bold: (s: string) => `\u001b[1m${s}\u001b[0m`,
};

type Manifest = {
  updatedAt: string;
  deliveries: number;
  captured: Record<string, { count: number; firstSeenAt: string; files: string[] }>;
};

const readManifest = (): Manifest => {
  if (!existsSync(MANIFEST_PATH)) {
    return { updatedAt: new Date().toISOString(), deliveries: 0, captured: {} };
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
};

const writeManifest = (manifest: Manifest): void => {
  manifest.updatedAt = new Date().toISOString();
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
};

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const printCoverage = (manifest: Manifest): void => {
  const missing = REQUIRED_FIXTURES.filter((f) => manifest.captured[f.slug] === undefined);
  const have = REQUIRED_FIXTURES.length - missing.length;

  if (missing.length === 0) {
    console.log(c.green(`  coverage ${have}/${REQUIRED_FIXTURES.length} — complete ✓`));
    return;
  }

  console.log(
    c.dim(`  coverage ${have}/${REQUIRED_FIXTURES.length} — next: ${missing[0].slug} (${missing[0].how})`),
  );
  if (missing.length > 1) {
    console.log(c.dim(`  still missing: ${missing.map((m) => m.slug).join(', ')}`));
  }
};

/** GET — Meta's subscription handshake. The body must be the bare challenge. */
const handleVerification = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode !== 'subscribe' || challenge === null) {
    console.log(c.yellow(`GET  ${url.pathname} → 400 (not a subscribe handshake)`));
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  if (!verifyMetaVerifyToken(token ?? undefined, VERIFY_TOKEN)) {
    console.log(c.red(`GET  ${url.pathname} → 403 verify token mismatch`));
    console.log(c.dim('     the token in the Meta dashboard must equal META_VERIFY_TOKEN in .dev.vars'));
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  console.log(c.green(`GET  ${url.pathname} → 200 handshake OK (probe P-1 passed)`));
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(challenge);
};

/** POST — capture a delivery. */
const handleDelivery = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const rawBody = await readBody(req);
  const header = req.headers[META_SIGNATURE_HEADER];
  const signatureHeader = Array.isArray(header) ? header[0] : header;

  // Ack immediately — Meta's budget is ~10 s and everything below is local I/O.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');

  // Verified two ways. Production only ever sees the utf8-decoded string
  // (twenty-sdk's RoutePayload.rawBody), so a divergence here would be a
  // production bug we must learn about in week 1, not in an incident.
  const validRaw = verifyMetaSignature({ rawBody, header: signatureHeader, appSecret: APP_SECRET });
  const validDecoded = verifyMetaSignature({
    rawBody: rawBody.toString('utf8'),
    header: signatureHeader,
    appSecret: APP_SECRET,
  });

  const stampOf = (): string => new Date().toISOString().replace(/[:.]/g, '-');

  // A body we cannot verify is not a trustworthy fixture, and a public tunnel
  // attracts scanners. Quarantine it: no committed fixture, no coverage credit,
  // but kept on disk and asserted-empty by the conformance suite so a genuine
  // Meta verification failure is loud rather than lost.
  if (!validRaw) {
    writeFileSync(
      join(INVALID_DIR, `rejected--${stampOf()}.json`),
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          signatureHeader: signatureHeader ?? null,
          remoteAddress: req.socket.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          rawBodyBase64: rawBody.toString('base64'),
        },
        null,
        2,
      )}\n`,
    );

    console.log(c.red(`POST sig ✗ REJECTED ${c.dim('→ raw/invalid/')}`));
    console.log(
      c.red('     If this was Meta: check META_APP_SECRET, and confirm the tunnel is not'),
    );
    console.log(c.red('     rewriting or re-encoding the body. If it was a scanner: delete the file.'));
    return;
  }

  let body: MetaWebhookBody;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as MetaWebhookBody;
  } catch {
    console.log(c.red('POST → signature valid but body is not JSON; stored as unparsed'));
    body = {};
  }

  const changes = (body.entry ?? []).flatMap((entry) => entry.changes ?? []);
  const classifications = changes.map(classifyChange);
  const isSample = isMetaSampleDelivery(body);
  // A sample still says *which* event it is: Meta's Test button is the only
  // source of authoritative payloads for the non-message fields, so collapsing
  // them all to one slug threw away the reason they are worth keeping.
  const classified = classifications.flatMap((cl) => cl.slugs);
  const slugs = isSample
    ? (classified.length > 0 ? classified : ['unknown']).map((slug) => `sample-${slug}`)
    : classified;
  const primarySlug = slugs[0] ?? 'unknown';

  const base = `${primarySlug}--${stampOf()}`;

  const { redacted, phoneMap } = redactWebhookPayload(body);

  // Committed: redacted, parseable, no real numbers.
  writeFileSync(
    join(FIXTURE_DIR, `${base}.json`),
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        synthetic: false,
        isMetaDashboardSample: isSample,
        note: isSample
          ? "Meta's dashboard Test payload. Genuinely signed, but the wamid, phone_number_id "
            + 'and timestamp are fabricated — do not use as a message fixture.'
          : undefined,
        slugs,
        fields: classifications.map((cl) => cl.field),
        kinds: [...new Set(classifications.flatMap((cl) => cl.kinds))],
        headers: Object.fromEntries(
          KEPT_HEADERS.filter((h) => h !== META_SIGNATURE_HEADER && req.headers[h] !== undefined).map(
            (h) => [h, req.headers[h]],
          ),
        ),
        body: redacted,
      },
      null,
      2,
    )}\n`,
  );

  // Gitignored: exact bytes + the real signature. A body/signature pair is an
  // oracle for the App Secret, so it never leaves this machine.
  writeFileSync(
    join(RAW_DIR, `${base}.json`),
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        signatureHeader: signatureHeader ?? null,
        signatureValidRaw: validRaw,
        signatureValidDecoded: validDecoded,
        rawBodyBase64: rawBody.toString('base64'),
      },
      null,
      2,
    )}\n`,
  );

  const manifest = readManifest();
  manifest.deliveries += 1;
  for (const slug of isSample ? [] : slugs) {
    const entry = manifest.captured[slug] ?? {
      count: 0,
      firstSeenAt: new Date().toISOString(),
      files: [],
    };
    entry.count += 1;
    if (!entry.files.includes(`${base}.json`)) entry.files.push(`${base}.json`);
    manifest.captured[slug] = entry;
  }
  writeManifest(manifest);

  const sigMark = validRaw ? c.green('sig ✓') : c.red('sig ✗');
  console.log(`POST ${sigMark} ${c.bold(slugs.join(' + ') || 'unknown')} ${c.dim(`→ ${base}.json`)}`);

  if (isSample) {
    console.log(
      c.yellow("     Meta's dashboard Test payload — signature path confirmed, but the wamid,"),
    );
    console.log(c.yellow('     phone_number_id and timestamp are fabricated. No coverage credit;'));
    console.log(c.yellow('     send a real message from the device for the inbound-text fixture.'));
  }

  if (!validRaw) {
    console.log(c.red('     signature INVALID — check META_APP_SECRET, and make sure the tunnel'));
    console.log(c.red('     is not rewriting or re-encoding the request body.'));
  } else if (validRaw !== validDecoded) {
    console.log(
      c.red('     raw bytes verify but the utf8-decoded string does NOT — production would fail here.'),
    );
  }

  if (phoneMap.size > 0) {
    console.log(c.dim(`     redacted ${phoneMap.size} phone number(s) in the committed copy`));
  }

  printCoverage(manifest);
};

const main = (): void => {
  if (APP_SECRET === undefined || APP_SECRET.length === 0) {
    console.error(c.red('META_APP_SECRET is not set. Run via `yarn capture` so .dev.vars is loaded.'));
    process.exit(1);
  }
  if (VERIFY_TOKEN === undefined || VERIFY_TOKEN.length === 0) {
    console.error(c.red('META_VERIFY_TOKEN is not set. Add one to .dev.vars (openssl rand -hex 32).'));
    process.exit(1);
  }

  mkdirSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(INVALID_DIR, { recursive: true });

  createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    if (req.method === 'GET') {
      handleVerification(req, res, url);
      return;
    }

    if (req.method === 'POST') {
      void handleDelivery(req, res).catch((error: unknown) => {
        console.error(c.red(`capture failed: ${String(error)}`));
      });
      return;
    }

    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('Method Not Allowed');
  }).listen(PORT, () => {
    console.log(c.bold(`\nWhatsApp webhook capture listening on http://localhost:${PORT}`));
    console.log(c.dim(`fixtures → src/__tests__/fixtures/meta/       (redacted, committed)`));
    console.log(c.dim(`raw      → src/__tests__/fixtures/meta/raw/   (exact bytes, gitignored)`));
    console.log(c.dim(`verify token loaded (${VERIFY_TOKEN.length} chars); app secret loaded\n`));
    console.log('Expose it, then paste the https URL into Meta → WhatsApp → Configuration:');
    console.log(c.bold(`  cloudflared tunnel --url http://localhost:${PORT}\n`));
    printCoverage(readManifest());
    console.log('');
  });
};

main();
