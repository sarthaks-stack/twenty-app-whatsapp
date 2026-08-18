import type { RestApiClient } from 'twenty-client-sdk/rest';

import {
  MEDIA_LIMITS,
  normaliseMimeType,
  validateOutboundMedia,
  type OutboundMediaKind,
} from '../../../domain/media-limits';

/**
 * The browser half of `wa-upload-route`: bytes the page holds, into Twenty
 * storage.
 *
 * It began as the voice recorder's private plumbing. The probe run for D-53
 * then showed the sandbox docs wrong about `FileReader` — it exists, and
 * `Blob.arrayBuffer()` works — which makes a *device* file picker feasible
 * after all: a `File` from an `<input type="file">` is a `Blob`, and a `Blob`
 * is bytes the page holds. So the pipeline moved here, shared between the
 * recorder and the attachment panel, and the spec sentence "a device picker
 * cannot work" is retired where it was proven wrong.
 */

/**
 * Mirror of `wa-upload-route.MAX_UPLOAD_BYTES`, which cannot be imported here:
 * the route module pulls in server code (environment reads, HTTP) that does
 * not exist in the sandbox. A unit test in `upload.test.ts` holds the two
 * equal, the same pattern D-15 uses for `PERSON_OBJECT_UID`.
 */
export const MAX_DEVICE_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Which WhatsApp kind a picked file should travel as.
 *
 * Deliberately conservative: WhatsApp accepts only jpeg/png as `image` and
 * mp4/3gpp as `video`, so a webp photo or a .mov clip is offered as a
 * *document* — which arrives, with a filename, rather than being refused three
 * steps later by Meta's validator. The rep sees the detected kind before
 * sending.
 */
export const deviceMediaKind = (
  mimeType: string | null | undefined,
): Exclude<OutboundMediaKind, 'sticker'> => {
  const mime = normaliseMimeType(mimeType);

  if (MEDIA_LIMITS.image.mimeTypes.includes(mime)) return 'image';
  if (MEDIA_LIMITS.video.mimeTypes.includes(mime)) return 'video';
  if (MEDIA_LIMITS.audio.mimeTypes.includes(mime)) return 'audio';

  return 'document';
};

export type DeviceFileVerdict =
  | { ok: true }
  | { ok: false; reason: 'TOO_LARGE_FOR_UPLOAD' | 'MEDIA_TOO_LARGE' | 'MEDIA_WRONG_TYPE'; detail: string };

/**
 * Everything that can be known to be wrong *before* the bytes move: Meta's
 * per-kind ceiling, the mime allow-list, and the upload route's own cap. Run
 * on pick, not on send — a refused file must be refused while the rep can
 * still choose another.
 */
export const validateDeviceFile = ({
  kind,
  mimeType,
  sizeBytes,
}: {
  kind: OutboundMediaKind;
  mimeType: string | null | undefined;
  sizeBytes: number;
}): DeviceFileVerdict => {
  const verdict = validateOutboundMedia({ kind, mimeType, sizeBytes });

  if (!verdict.ok) {
    return verdict.reason === 'MEDIA_TOO_LARGE'
      ? { ok: false, reason: 'MEDIA_TOO_LARGE', detail: verdict.detail }
      : { ok: false, reason: 'MEDIA_WRONG_TYPE', detail: verdict.detail };
  }

  if (sizeBytes > MAX_DEVICE_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: 'TOO_LARGE_FOR_UPLOAD',
      detail: `${sizeBytes} bytes exceeds the ${MAX_DEVICE_UPLOAD_BYTES}-byte direct-upload cap`,
    };
  }

  return { ok: true };
};

/**
 * Chunked, because `String.fromCharCode(...bytes)` on a megabyte of media
 * spreads a million arguments onto the call stack and throws — on exactly the
 * files large enough to matter. (Moved verbatim from the voice recorder.)
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
