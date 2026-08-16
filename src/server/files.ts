import { describeError, logger } from './logger';

/**
 * Reading a file back out of Twenty's own storage (specs/04 §5 step 6, D-18).
 *
 * The composer cannot read file bytes — the front-component sandbox has no
 * `FileReader` — so an outbound attachment is uploaded to Twenty storage first
 * and the send carries only a handle. Somewhere between that handle and Meta's
 * media endpoint, something has to fetch the bytes.
 *
 * **This is the one module outside the provider allowed to make an HTTP
 * request, and the allowance is narrow by construction.** `resolveFileUrl`
 * refuses any URL that is not on the workspace's own API origin, so the
 * function cannot be repurposed into a general HTTP client — in particular it
 * cannot be handed Meta's media CDN URL, which is the exact hole AR-11 exists
 * to close. A test asserts the guard is still here, because an exception to an
 * architectural rule that nobody re-checks is just a rule that was dropped.
 *
 * `RestApiClient` from the SDK is deliberately not used: it reads every
 * response with `response.text()`, which corrupts binary content silently.
 */

export class WorkspaceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceFileError';
  }
}

export type WorkspaceFileHandle = {
  /** Absolute URL as returned on a FILES column, or a `/files/...` path. */
  url?: string | null;
  /** Storage path as returned by `uploadFile`. */
  path?: string | null;
};

const apiBaseUrl = (): string => {
  const raw = process.env.TWENTY_API_URL;

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new WorkspaceFileError('TWENTY_API_URL is not set');
  }

  return raw.trim().replace(/\/+$/, '');
};

/**
 * Resolves a handle to an absolute URL **on the workspace's own origin**, and
 * throws otherwise.
 *
 * Relative forms are resolved rather than rejected because that is what the
 * platform hands us: a FILES column's `url` is frequently a path, and a caller
 * forced to reassemble the base URL would reassemble it wrongly somewhere.
 */
export const resolveFileUrl = (handle: WorkspaceFileHandle): string => {
  const base = apiBaseUrl();
  const raw = (handle.url ?? handle.path ?? '').trim();

  if (raw.length === 0) throw new WorkspaceFileError('No file url or path was given');

  const candidate = /^https?:\/\//i.test(raw)
    ? raw
    : `${base}/${raw.replace(/^\/+/, '')}`;

  let resolved: URL;
  let expected: URL;

  try {
    resolved = new URL(candidate);
    expected = new URL(base);
  } catch (error) {
    throw new WorkspaceFileError(`Could not parse the file url: ${String(error)}`);
  }

  /**
   * Origin equality, not a prefix or a `startsWith` on the string. A prefix
   * test passes for `https://twenty.example.com.attacker.test/`, which is the
   * classic way this check is written wrong.
   */
  if (resolved.origin !== expected.origin) {
    throw new WorkspaceFileError(
      `Refusing to read a file from ${resolved.origin}: only ${expected.origin} is a workspace file store`,
    );
  }

  return resolved.toString();
};

export type FetchLike = typeof globalThis.fetch;

export type DownloadedFile = { buffer: Buffer; mimeType: string };

/**
 * A workspace file read sits in the send path — a campaign's header image is
 * fetched before the template goes out — so it needs its own deadline. Without
 * one, a stalled connection held the sender until the platform's function
 * timeout, and every message behind it waited (D-45).
 */
export const FILE_TIMEOUT_MS = 30_000;

export const downloadWorkspaceFile = async (
  handle: WorkspaceFileHandle,
  { fetchImpl = globalThis.fetch }: { fetchImpl?: FetchLike } = {},
): Promise<DownloadedFile> => {
  const url = resolveFileUrl(handle);
  const token = process.env.TWENTY_APP_ACCESS_TOKEN;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers:
        typeof token === 'string' && token.length > 0
          ? { Authorization: `Bearer ${token}` }
          : {},
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new WorkspaceFileError(
        `Reading the file failed with HTTP ${response.status} ${response.statusText}`,
      );
    }

    // The body read stays inside the deadline; a stalled download is the case
    // the deadline exists for.
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;

    logger.warn('files.download_failed', describeError(error));

    throw new WorkspaceFileError(
      controller.signal.aborted
        ? `Reading the file timed out after ${FILE_TIMEOUT_MS} ms`
        : `Could not read the file: ${String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
};
