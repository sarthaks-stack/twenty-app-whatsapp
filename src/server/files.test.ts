import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceFileError, downloadWorkspaceFile, resolveFileUrl } from './files';

/**
 * `server/files.ts` is the only module outside the provider allowed to make an
 * HTTP request, so its origin guard is load-bearing for AR-11 rather than
 * merely defensive. These tests are what keeps the exception narrow — the
 * architecture test asserts the guard exists; these assert it works.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, TWENTY_API_URL: 'https://crm.example.test' };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolving a workspace file url', () => {
  it('accepts an absolute url on the workspace origin', () => {
    expect(resolveFileUrl({ url: 'https://crm.example.test/files/a/b.png' })).toBe(
      'https://crm.example.test/files/a/b.png',
    );
  });

  it('resolves a path against the api base', () => {
    expect(resolveFileUrl({ path: 'files/a/b.png' })).toBe(
      'https://crm.example.test/files/a/b.png',
    );
    expect(resolveFileUrl({ url: '/files/a/b.png' })).toBe(
      'https://crm.example.test/files/a/b.png',
    );
  });

  /**
   * The reason the guard exists. Meta's media CDN url arrives *inside* a
   * webhook payload, so a file reader that fetched whatever it was handed would
   * be a second, unclassified, unretried path to Meta — exactly what AR-11
   * forbids.
   */
  it('refuses Meta’s media CDN', () => {
    expect(() =>
      resolveFileUrl({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1' }),
    ).toThrow(WorkspaceFileError);
  });

  /**
   * A `startsWith` check passes for this host, which is why the guard compares
   * `URL.origin` instead.
   */
  it('refuses a hostname that merely begins with the workspace host', () => {
    expect(() => resolveFileUrl({ url: 'https://crm.example.test.attacker.test/files/x' })).toThrow(
      /Refusing to read a file/,
    );
  });

  it.each([
    ['a different scheme', 'http://crm.example.test/files/x'],
    ['a different port', 'https://crm.example.test:8443/files/x'],
    ['a bare other host', 'https://evil.test/files/x'],
  ])('refuses %s', (_label, url) => {
    expect(() => resolveFileUrl({ url })).toThrow(WorkspaceFileError);
  });

  it('refuses an empty handle', () => {
    expect(() => resolveFileUrl({})).toThrow(/No file url or path/);
  });

  it('fails closed when the api url is not configured', () => {
    delete process.env.TWENTY_API_URL;

    expect(() => resolveFileUrl({ url: 'https://crm.example.test/files/x' })).toThrow(
      /TWENTY_API_URL/,
    );
  });
});

describe('downloading a workspace file', () => {
  const response = (bytes: number[], contentType: string): Response =>
    new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
      status: 200,
      headers: { 'content-type': contentType },
    });

  it('returns the bytes and the content type', async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff];
    const fetchImpl = vi.fn().mockResolvedValue(response(bytes, 'image/png'));

    const file = await downloadWorkspaceFile(
      { path: 'files/a/b.png' },
      { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(file.mimeType).toBe('image/png');
    expect([...file.buffer]).toEqual(bytes);
  });

  /**
   * Binary fidelity is the whole reason this module exists rather than the
   * SDK's REST client, which reads every response with `.text()` and would
   * mangle these bytes into replacement characters without erroring.
   */
  it('preserves bytes that are not valid utf-8', async () => {
    const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x80, 0x81];
    const fetchImpl = vi.fn().mockResolvedValue(response(bytes, 'image/jpeg'));

    const file = await downloadWorkspaceFile(
      { path: 'files/x.jpg' },
      { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect([...file.buffer]).toEqual(bytes);
    expect(file.buffer.length).toBe(6);
  });

  it('never issues a request for a foreign origin', async () => {
    const fetchImpl = vi.fn();

    await expect(
      downloadWorkspaceFile(
        { url: 'https://lookaside.fbsbx.com/x' },
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toThrow(WorkspaceFileError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the app access token when there is one', async () => {
    process.env.TWENTY_APP_ACCESS_TOKEN = 'token-abc';

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response([1], 'application/pdf'));

    await downloadWorkspaceFile(
      { path: 'files/x.pdf' },
      { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: 'Bearer token-abc',
    });
  });

  /**
   * D-45. This read sits in the send path — a campaign's header image is
   * fetched before the template goes out — so a stalled connection used to
   * hold the sender until the platform's own timeout, with every message
   * behind it waiting.
   */
  it('passes an abort signal so a stalled read cannot hold the sender', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([1], 'image/png'));

    await downloadWorkspaceFile(
      { path: 'files/x.png' },
      { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('turns an aborted read into a WorkspaceFileError like any other failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(
      downloadWorkspaceFile(
        { path: 'files/slow.png' },
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toBeInstanceOf(WorkspaceFileError);
  });

  it('turns a non-200 into a WorkspaceFileError naming the status', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 404, statusText: 'Not Found' }));

    await expect(
      downloadWorkspaceFile(
        { path: 'files/missing.png' },
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toThrow(/404/);
  });
});
