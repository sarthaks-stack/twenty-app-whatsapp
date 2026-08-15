import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  computeMetaSignature,
  constantTimeEquals,
  verifyMetaSignature,
  verifyMetaVerifyToken,
} from './verify-signature';

const APP_SECRET = 'test-app-secret-0123456789abcdef';

const sign = (body: string | Buffer, secret = APP_SECRET): string =>
  `sha256=${createHmac('sha256', secret)
    .update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
    .digest('hex')}`;

describe('computeMetaSignature', () => {
  it('matches a precomputed vector', () => {
    // Independently computable: printf '%s' '{"a":1}' | openssl dgst -sha256 -hmac 'k'
    expect(computeMetaSignature('{"a":1}', 'k')).toBe(
      `sha256=${createHmac('sha256', 'k').update('{"a":1}').digest('hex')}`,
    );
  });

  it('treats a utf8 string and its bytes identically', () => {
    const text = '{"text":{"body":"Olá, tudo bem? 🎉"}}';

    expect(computeMetaSignature(text, APP_SECRET)).toBe(
      computeMetaSignature(Buffer.from(text, 'utf8'), APP_SECRET),
    );
  });
});

describe('constantTimeEquals', () => {
  it('is true for equal strings and false otherwise', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });

  it('does not throw on differing lengths (no length oracle)', () => {
    expect(() => constantTimeEquals('a', 'aaaaaaaaaaaaaaaaaaaa')).not.toThrow();
    expect(constantTimeEquals('a', 'aaaaaaaaaaaaaaaaaaaa')).toBe(false);
  });

  it('handles the empty string', () => {
    expect(constantTimeEquals('', '')).toBe(true);
    expect(constantTimeEquals('', 'x')).toBe(false);
  });
});

describe('verifyMetaSignature', () => {
  const rawBody = '{"object":"whatsapp_business_account","entry":[]}';

  it('accepts a correctly signed body', () => {
    expect(
      verifyMetaSignature({ rawBody, header: sign(rawBody), appSecret: APP_SECRET }),
    ).toBe(true);
  });

  it('accepts the same body as a Buffer', () => {
    const buffer = Buffer.from(rawBody, 'utf8');

    expect(
      verifyMetaSignature({ rawBody: buffer, header: sign(buffer), appSecret: APP_SECRET }),
    ).toBe(true);
  });

  it('tolerates surrounding whitespace in the header', () => {
    expect(
      verifyMetaSignature({ rawBody, header: `  ${sign(rawBody)} `, appSecret: APP_SECRET }),
    ).toBe(true);
  });

  it.each([
    ['wrong secret', sign(rawBody, 'other-secret'), APP_SECRET],
    ['no sha256= prefix', sign(rawBody).replace('sha256=', ''), APP_SECRET],
    ['sha1 prefix', sign(rawBody).replace('sha256=', 'sha1='), APP_SECRET],
    ['truncated digest', sign(rawBody).slice(0, 30), APP_SECRET],
    ['empty header', '', APP_SECRET],
    ['prefix only', 'sha256=', APP_SECRET],
  ])('rejects %s', (_label, header, appSecret) => {
    expect(verifyMetaSignature({ rawBody, header, appSecret })).toBe(false);
  });

  it('rejects a body that does not match the signature', () => {
    expect(
      verifyMetaSignature({
        rawBody: `${rawBody} `,
        header: sign(rawBody),
        appSecret: APP_SECRET,
      }),
    ).toBe(false);
  });

  it('fails closed when the header is missing', () => {
    expect(verifyMetaSignature({ rawBody, header: undefined, appSecret: APP_SECRET })).toBe(false);
  });

  it('fails closed when the raw body was not forwarded', () => {
    expect(
      verifyMetaSignature({ rawBody: undefined, header: sign(rawBody), appSecret: APP_SECRET }),
    ).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
  ])('fails closed when the app secret is %s', (_label, appSecret) => {
    expect(verifyMetaSignature({ rawBody, header: sign(rawBody), appSecret })).toBe(false);
  });

  /**
   * The regression guard named in specs/12-testing.md §1.4.
   *
   * Meta escapes non-ASCII as \uXXXX. Re-serialising the parsed body produces
   * the same JSON *value* with different bytes, so any implementation that
   * verifies against `JSON.stringify(JSON.parse(raw))` passes every ASCII test
   * and then rejects every real Portuguese message in production.
   */
  describe('raw bytes, not re-serialised JSON', () => {
    const metaStyleBody =
      '{"messages":[{"text":{"body":"Ol\\u00e1 Jo\\u00e3o, a proposta segue em anexo \\ud83c\\udf89"}}]}';

    it('verifies the body exactly as received', () => {
      expect(
        verifyMetaSignature({
          rawBody: metaStyleBody,
          header: sign(metaStyleBody),
          appSecret: APP_SECRET,
        }),
      ).toBe(true);
    });

    it('fails when the body is re-serialised — the bug this test exists to catch', () => {
      const reserialised = JSON.stringify(JSON.parse(metaStyleBody));

      expect(reserialised).not.toBe(metaStyleBody);
      expect(
        verifyMetaSignature({
          rawBody: reserialised,
          header: sign(metaStyleBody),
          appSecret: APP_SECRET,
        }),
      ).toBe(false);
    });

    it('round-trips a literal-unicode body through Buffer and string alike', () => {
      const literal = '{"body":"Olá João 🎉"}';

      expect(
        verifyMetaSignature({ rawBody: literal, header: sign(literal), appSecret: APP_SECRET }),
      ).toBe(true);
      expect(
        verifyMetaSignature({
          rawBody: Buffer.from(literal, 'utf8'),
          header: sign(literal),
          appSecret: APP_SECRET,
        }),
      ).toBe(true);
    });
  });
});

describe('verifyMetaVerifyToken', () => {
  it('accepts an exact match', () => {
    expect(verifyMetaVerifyToken('s3cr3t', 's3cr3t')).toBe(true);
  });

  it.each([
    ['mismatch', 's3cr3t', 'other'],
    ['case difference', 'S3CR3T', 's3cr3t'],
    ['prefix only', 's3cr', 's3cr3t'],
    ['provided empty', '', 's3cr3t'],
    ['expected empty', 's3cr3t', ''],
    ['provided undefined', undefined, 's3cr3t'],
    ['expected undefined', 's3cr3t', undefined],
  ])('rejects %s', (_label, provided, expected) => {
    expect(verifyMetaVerifyToken(provided, expected)).toBe(false);
  });
});
