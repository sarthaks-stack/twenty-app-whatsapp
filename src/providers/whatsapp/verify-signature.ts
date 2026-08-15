import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta webhook authenticity. Specified in specs/03-webhook-ingestion.md §2.1 (AR-6, SEC-2).
 *
 * Deliberately dependency-free so it can run in three places unchanged: the
 * `wa-webhook-resolver` logic function, the unit suite, and the capture harness
 * in tools/webhook-capture. The harness importing *this* module is what makes a
 * capture session a live conformance test rather than a separate implementation.
 */

export const META_SIGNATURE_HEADER = 'x-hub-signature-256';

const SIGNATURE_PREFIX = 'sha256=';

const toBuffer = (body: string | Buffer): Buffer =>
  typeof body === 'string' ? Buffer.from(body, 'utf8') : body;

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws when the inputs differ in length, and that throw is
 * itself a length oracle, so both sides are hashed to a fixed 32 bytes first.
 */
export const constantTimeEquals = (a: string, b: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(a, 'utf8').digest(),
    createHash('sha256').update(b, 'utf8').digest(),
  );

/**
 * The value Meta puts in `X-Hub-Signature-256`: HMAC-SHA256 of the raw request
 * body, keyed with the Meta App Secret, hex-encoded, prefixed `sha256=`.
 */
export const computeMetaSignature = (
  rawBody: string | Buffer,
  appSecret: string,
): string =>
  `${SIGNATURE_PREFIX}${createHmac('sha256', appSecret).update(toBuffer(rawBody)).digest('hex')}`;

export type VerifyMetaSignatureInput = {
  /**
   * The body exactly as received. Passing a re-serialised object
   * (`JSON.stringify(JSON.parse(raw))`) will fail verification: Meta escapes
   * non-ASCII as \uXXXX, and any Portuguese accent or emoji changes the bytes.
   */
  rawBody: string | Buffer | undefined;
  header: string | undefined;
  appSecret: string | undefined;
};

export const verifyMetaSignature = ({
  rawBody,
  header,
  appSecret,
}: VerifyMetaSignatureInput): boolean => {
  if (rawBody === undefined) return false;
  if (typeof appSecret !== 'string' || appSecret.length === 0) return false;
  if (typeof header !== 'string') return false;

  const provided = header.trim();

  if (!provided.startsWith(SIGNATURE_PREFIX)) return false;

  return constantTimeEquals(provided, computeMetaSignature(rawBody, appSecret));
};

/**
 * The GET handshake half (specs/03 §1). Meta sends the token as a query
 * parameter; it is compared in constant time and never logged.
 */
export const verifyMetaVerifyToken = (
  provided: string | undefined,
  expected: string | undefined,
): boolean => {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (typeof expected !== 'string' || expected.length === 0) return false;

  return constantTimeEquals(provided, expected);
};
