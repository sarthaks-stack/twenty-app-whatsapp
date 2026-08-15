import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { verifyMetaSignature } from '../providers/whatsapp/verify-signature';

/**
 * Conformance test over real, captured Meta deliveries.
 *
 * The unit suite in verify-signature.test.ts proves the implementation against
 * signatures we computed ourselves — which cannot catch a wrong understanding
 * of *what Meta signs*. This one runs the same production verifier over bytes
 * Meta actually sent, with the signature Meta actually attached.
 *
 * Populate it with `yarn capture` (see tools/webhook-capture/README.md). The
 * raw fixtures are gitignored, so this suite reports as skipped on a clean
 * checkout and on CI, and becomes a hard gate on any machine that has captured.
 */

const RAW_DIR = join(process.cwd(), 'src/__tests__/fixtures/meta/raw');
const INVALID_DIR = join(RAW_DIR, 'invalid');

type RawCapture = {
  capturedAt: string;
  signatureHeader: string | null;
  signatureValidRaw: boolean;
  signatureValidDecoded: boolean;
  rawBodyBase64: string;
};

const loadAppSecret = (): string | undefined => {
  if (typeof process.env.META_APP_SECRET === 'string') return process.env.META_APP_SECRET;

  try {
    process.loadEnvFile(join(process.cwd(), '.dev.vars'));
  } catch {
    return undefined;
  }

  return process.env.META_APP_SECRET;
};

const loadCaptures = (): { name: string; capture: RawCapture }[] => {
  if (!existsSync(RAW_DIR)) return [];

  return readdirSync(RAW_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      name,
      capture: JSON.parse(readFileSync(join(RAW_DIR, name), 'utf8')) as RawCapture,
    }));
};

const appSecret = loadAppSecret();
const captures = loadCaptures();

const reason =
  captures.length === 0
    ? 'no captured deliveries yet — run `yarn capture`'
    : appSecret === undefined
      ? 'META_APP_SECRET unavailable (.dev.vars not present)'
      : null;

const invalidCaptures = existsSync(INVALID_DIR)
  ? readdirSync(INVALID_DIR).filter((name) => name.endsWith('.json'))
  : [];

/**
 * Runs even with no captures: a quarantined delivery is a finding whether or
 * not anything verified successfully. Either the App Secret / tunnel is wrong,
 * or a scanner found the endpoint — the first is a bug, the second is noise you
 * delete, and both should be a decision rather than a silent file on disk.
 */
describe('rejected Meta deliveries', () => {
  it('has no quarantined deliveries awaiting triage', () => {
    expect(
      invalidCaptures,
      `${invalidCaptures.length} delivery/deliveries failed signature verification and are in ` +
        'src/__tests__/fixtures/meta/raw/invalid/. If they came from Meta, check META_APP_SECRET ' +
        'and whether the tunnel re-encodes the body. If they were internet scanners, delete them.',
    ).toEqual([]);
  });
});

describe.skipIf(reason !== null)('captured Meta signatures', () => {
  it('has captures to verify', () => {
    expect(captures.length).toBeGreaterThan(0);
  });

  it.each(captures.map((c) => [c.name, c.capture] as const))(
    'verifies %s against the production verifier',
    (_name, capture) => {
      const rawBody = Buffer.from(capture.rawBodyBase64, 'base64');

      expect(
        verifyMetaSignature({
          rawBody,
          header: capture.signatureHeader ?? undefined,
          appSecret,
        }),
      ).toBe(true);
    },
  );

  /**
   * `twenty-sdk` hands the resolver `rawBody` as a **string**, never a Buffer.
   * If a real Meta payload ever verified as bytes but not as a utf8 string, the
   * production resolver would reject a legitimate delivery — so this asserts
   * the two agree on every captured payload, not just on our own test vectors.
   */
  it.each(captures.map((c) => [c.name, c.capture] as const))(
    'agrees between raw bytes and the utf8 string for %s',
    (_name, capture) => {
      const rawBody = Buffer.from(capture.rawBodyBase64, 'base64');

      expect(
        verifyMetaSignature({
          rawBody: rawBody.toString('utf8'),
          header: capture.signatureHeader ?? undefined,
          appSecret,
        }),
      ).toBe(true);
    },
  );

  it('rejects every captured payload under a wrong secret', () => {
    for (const { capture } of captures) {
      expect(
        verifyMetaSignature({
          rawBody: Buffer.from(capture.rawBodyBase64, 'base64'),
          header: capture.signatureHeader ?? undefined,
          appSecret: 'not-the-app-secret',
        }),
      ).toBe(false);
    }
  });

  it('rejects every captured payload when a single byte is flipped', () => {
    for (const { capture } of captures) {
      const tampered = Buffer.from(capture.rawBodyBase64, 'base64');
      tampered[tampered.length - 1] ^= 0x01;

      expect(
        verifyMetaSignature({
          rawBody: tampered,
          header: capture.signatureHeader ?? undefined,
          appSecret,
        }),
      ).toBe(false);
    }
  });
});

if (reason !== null) {
  // Visible in the run output rather than silently absent.
  console.log(`[captured-signatures] skipped: ${reason}`);
}
