import type { RestApiClient } from 'twenty-client-sdk/rest';

import type { OutboundMediaKind } from '../../../domain/media-limits';

/**
 * The browser half of `wa-upload-route`: bytes the page holds, into Twenty
 * storage.
 *
 * This is the voice recorder's plumbing, and — after a detour — only that. A
 * device file picker briefly shared it, on the strength of the D-53 probe
 * showing `Blob.arrayBuffer()` works in the sandbox. It does, but only on
 * blobs the page *creates* (like the recorder's): a `File` picked through
 * `<input type="file">` crosses the sandbox bridge as a metadata proxy with
 * no `Blob` methods, unreadable by `arrayBuffer()` and `FileReader` alike
 * (live failure: `e.arrayBuffer is not a function`). The platform docs said
 * so all along; the picker was removed (D-53 field correction, specs/00).
 */

/**
 * Mirror of `wa-upload-route.MAX_UPLOAD_BYTES`, which cannot be imported here:
 * the route module pulls in server code (environment reads, HTTP) that does
 * not exist in the sandbox. A unit test in `upload.test.ts` holds the two
 * equal, the same pattern D-15 uses for `PERSON_OBJECT_UID`.
 */
export const MAX_DEVICE_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Chunked, because `String.fromCharCode(...bytes)` on a megabyte of media
 * spreads a million arguments onto the call stack and throws — on exactly the
 * files large enough to matter.
 */
export const blobToBase64 = async (blob: Blob): Promise<string> => {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let binary = '';

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return btoa(binary);
};

export type StoredUpload = { fileUrl: string; filePath: string };

/**
 * `Blob` → base64 → `POST /s/whatsapp/upload`, reporting which of the two slow
 * halves is running so the panel can say so — the sandbox's fetch exposes no
 * byte-level progress, but "preparing" versus "uploading" is the honest
 * granularity it does have.
 */
export const uploadDeviceFile = async ({
  client,
  blob,
  filename,
  contentType,
  mediaKind,
  onPhase,
}: {
  client: RestApiClient;
  blob: Blob;
  filename: string;
  contentType: string;
  mediaKind: OutboundMediaKind;
  onPhase?: (phase: 'reading' | 'uploading') => void;
}): Promise<StoredUpload> => {
  onPhase?.('reading');

  const data = await blobToBase64(blob);

  onPhase?.('uploading');

  const stored = await client.post<{ fileUrl?: string; filePath?: string }>(
    '/s/whatsapp/upload',
    { filename, contentType, mediaKind, data },
  );

  if (typeof stored.filePath !== 'string' && typeof stored.fileUrl !== 'string') {
    throw new Error('upload returned no handle');
  }

  return { fileUrl: stored.fileUrl ?? '', filePath: stored.filePath ?? '' };
};
