/**
 * Reading an HTTP response body under a byte ceiling.
 *
 * `response.arrayBuffer()` buffers whatever the peer sends before anyone can
 * look at the length, so a hostile or misconfigured server could hold tens of
 * gigabytes of "media" against a worker's memory. The declared
 * `content-length` is checked first — it refuses the honest oversize cheaply —
 * and the stream is then counted chunk by chunk, so a body that lies about its
 * size is cut off at the ceiling rather than after it has already landed.
 *
 * This module makes no HTTP request of its own; the callers (the provider and
 * `server/files.ts`) remain the only modules allowed to (AR-11).
 */

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response body exceeds the ${maxBytes}-byte ceiling`);
    this.name = 'BodyTooLargeError';
  }
}

export const readBodyCapped = async (
  response: Response,
  maxBytes: number,
): Promise<Buffer> => {
  const declared = Number(response.headers.get('content-length'));

  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }

  const body = response.body;

  if (body === null) {
    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > maxBytes) throw new BodyTooLargeError(maxBytes);

    return buffer;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > maxBytes) throw new BodyTooLargeError(maxBytes);

      chunks.push(Buffer.from(value));
    }
  } finally {
    if (total > maxBytes) await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks);
};
