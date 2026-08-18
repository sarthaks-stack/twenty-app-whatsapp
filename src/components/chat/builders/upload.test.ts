import { describe, expect, it } from 'vitest';

import { MAX_UPLOAD_BYTES } from '../../../logic-functions/wa-upload-route';
import {
  MAX_DEVICE_UPLOAD_BYTES,
  deviceMediaKind,
  validateDeviceFile,
} from './upload';

describe('deviceMediaKind', () => {
  it('sends what WhatsApp accepts as media, as media', () => {
    expect(deviceMediaKind('image/jpeg')).toBe('image');
    expect(deviceMediaKind('image/png')).toBe('image');
    expect(deviceMediaKind('video/mp4')).toBe('video');
    expect(deviceMediaKind('audio/mpeg')).toBe('audio');
  });

  /**
   * A webp photo sent as `image` is refused by Meta's validator after the
   * upload; sent as a document it arrives. The conservative kind is the one
   * that delivers.
   */
  it('demotes formats Meta refuses in their own kind to documents', () => {
    expect(deviceMediaKind('image/webp')).toBe('document');
    expect(deviceMediaKind('video/quicktime')).toBe('document');
    expect(deviceMediaKind('application/pdf')).toBe('document');
    expect(deviceMediaKind(null)).toBe('document');
  });
});

describe('validateDeviceFile', () => {
  it('accepts an ordinary photo', () => {
    expect(
      validateDeviceFile({ kind: 'image', mimeType: 'image/jpeg', sizeBytes: 1024 }),
    ).toEqual({ ok: true });
  });

  it("refuses a file over Meta's per-kind ceiling, before any bytes move", () => {
    const verdict = validateDeviceFile({
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 6 * 1024 * 1024,
    });

    expect(verdict).toMatchObject({ ok: false, reason: 'MEDIA_TOO_LARGE' });
  });

  it("refuses a file over the upload route's own cap", () => {
    const verdict = validateDeviceFile({
      kind: 'document',
      mimeType: 'application/pdf',
      sizeBytes: MAX_DEVICE_UPLOAD_BYTES + 1,
    });

    expect(verdict).toMatchObject({ ok: false, reason: 'TOO_LARGE_FOR_UPLOAD' });
  });

  it('refuses a mime the chosen kind cannot carry', () => {
    const verdict = validateDeviceFile({
      kind: 'image',
      mimeType: 'image/webp',
      sizeBytes: 1024,
    });

    expect(verdict).toMatchObject({ ok: false, reason: 'MEDIA_WRONG_TYPE' });
  });
});

/**
 * The sandbox copy of the route's cap, held equal the same way D-15 holds
 * `PERSON_OBJECT_UID`: this test runs in Node, where both modules load, so the
 * mirrored constant cannot drift.
 */
it('mirrors the upload route byte cap exactly', () => {
  expect(MAX_DEVICE_UPLOAD_BYTES).toBe(MAX_UPLOAD_BYTES);
});
