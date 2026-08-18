import { describe, expect, it } from 'vitest';

import { MAX_UPLOAD_BYTES } from '../../../logic-functions/wa-upload-route';
import { MAX_DEVICE_UPLOAD_BYTES, blobToBase64 } from './upload';

/**
 * The sandbox copy of the route's cap, held equal the same way D-15 holds
 * `PERSON_OBJECT_UID`: this test runs in Node, where both modules load, so the
 * mirrored constant cannot drift.
 */
it('mirrors the upload route byte cap exactly', () => {
  expect(MAX_DEVICE_UPLOAD_BYTES).toBe(MAX_UPLOAD_BYTES);
});

describe('blobToBase64', () => {
  it('encodes a page-created blob, the only kind that still flows here', async () => {
    expect(await blobToBase64(new Blob(['hi']))).toBe('aGk=');
  });
});
