import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCloudApiProvider } from './cloud-api.provider';
import { MissingConfigError, requireSecret } from './config';
import { ERROR_CLASS, MetaApiError, classify } from './errors';
import { getProvider, resetProviderCache } from './index';

/**
 * Transport behaviour with `fetch` stubbed. What matters here is not that a URL
 * is well formed but that each failure mode maps to the outcome the outbound
 * pipeline depends on — particularly the one that must never be retried.
 */

const ORIGINAL_ENV = { ...process.env };

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.META_ACCESS_TOKEN = 'test-token';
  process.env.META_GRAPH_VERSION = 'v26.0';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  resetProviderCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  resetProviderCache();
});

const provider = () => createCloudApiProvider();

describe('config', () => {
  /** SEC-1: no default, no `?? ''`, no development fallback. */
  it('fails closed on a missing secret', () => {
    delete process.env.META_ACCESS_TOKEN;

    expect(() => requireSecret('META_ACCESS_TOKEN')).toThrow(MissingConfigError);
  });

  it('treats a whitespace-only value as missing', () => {
    process.env.META_ACCESS_TOKEN = '   ';

    expect(() => requireSecret('META_ACCESS_TOKEN')).toThrow(MissingConfigError);
  });

  it('never puts the value in the error message', () => {
    process.env.META_APP_SECRET = 'super-secret';
    delete process.env.META_VERIFY_TOKEN;

    try {
      requireSecret('META_VERIFY_TOKEN');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('META_VERIFY_TOKEN');
      expect((error as Error).message).not.toContain('super-secret');
    }
  });
});

describe('sendMessage', () => {
  it('posts to the pinned Graph version with a bearer token', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        contacts: [{ input: '244917164819', wa_id: '244917164819' }],
        messages: [{ id: 'wamid.ABC' }],
      }),
    );

    const result = await provider().sendMessage({
      phoneNumberId: '1206450239224164',
      payload: {
        messaging_product: 'whatsapp',
        to: '244917164819',
        type: 'text',
        text: { body: 'Olá' },
      },
    });

    expect(result).toMatchObject({ wamid: 'wamid.ABC', resolvedWaId: '244917164819' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v26.0/1206450239224164/messages');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer test-token',
    );
  });

  /**
   * The WAMID is the idempotency key for every status webhook that follows. A
   * record without one can never be matched, so a 200 without it is an error.
   */
  it('refuses a success response carrying no message id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { messages: [] }));

    await expect(
      provider().sendMessage({
        phoneNumberId: '1',
        payload: { messaging_product: 'whatsapp', to: '2', type: 'text' },
      }),
    ).rejects.toThrow(MetaApiError);
  });

  it('turns a Graph error body into a classified MetaApiError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { message: 'Re-engagement', code: 131047 } }),
    );

    await expect(
      provider().sendMessage({
        phoneNumberId: '1',
        payload: { messaging_product: 'whatsapp', to: '2', type: 'text' },
      }),
    ).rejects.toMatchObject({ code: 131047, httpStatus: 400 });
  });

  /**
   * The single most consequential branch in the transport: an abort means the
   * request was fully written and the outcome is unknown. Retrying could send
   * the customer a duplicate.
   */
  it('marks a timed-out send ambiguous rather than retryable', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    try {
      await provider().sendMessage({
        phoneNumberId: '1',
        payload: { messaging_product: 'whatsapp', to: '2', type: 'text' },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as MetaApiError).ambiguous).toBe(true);
      expect(classify(error as MetaApiError).class).toBe(ERROR_CLASS.TERMINAL_UNKNOWN);
    }
  });

  it('treats a connection failure as retryable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    try {
      await provider().sendMessage({
        phoneNumberId: '1',
        payload: { messaging_product: 'whatsapp', to: '2', type: 'text' },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as MetaApiError).ambiguous).toBe(false);
      expect(classify(error as MetaApiError).class).toBe(ERROR_CLASS.RETRYABLE_BACKOFF);
    }
  });

  it('does not choke on a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));

    await expect(
      provider().sendMessage({
        phoneNumberId: '1',
        payload: { messaging_product: 'whatsapp', to: '2', type: 'text' },
      }),
    ).rejects.toMatchObject({ httpStatus: 502 });
  });
});

describe('media', () => {
  it('resolves a media id to a download handle', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        url: 'https://lookaside.fbsbx.com/x',
        mime_type: 'audio/ogg',
        file_size: 12345,
        sha256: 'abc',
      }),
    );

    expect(await provider().fetchMediaUrl('987')).toEqual({
      url: 'https://lookaside.fbsbx.com/x',
      mimeType: 'audio/ogg',
      fileSize: 12345,
      sha256: 'abc',
    });
  });

  it('parses a string file_size', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { url: 'https://x/y', file_size: '999' }));

    expect((await provider().fetchMediaUrl('1')).fileSize).toBe(999);
  });

  /** C-6: the CDN URL is not a Graph call but still needs the bearer token. */
  it('downloads from the CDN URL verbatim, with the token attached', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/ogg' },
      }),
    );

    const result = await provider().downloadMedia('https://lookaside.fbsbx.com/attachments/?mid=1');

    expect(result.mimeType).toBe('audio/ogg');
    expect([...result.buffer]).toEqual([1, 2, 3]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://lookaside.fbsbx.com/attachments/?mid=1');
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer test-token',
    );
  });

  /** The short-lived URL expiring is normal; the caller re-resolves from the id. */
  it('surfaces an expired URL as a 410 the caller can act on', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 410 }));

    await expect(provider().downloadMedia('https://x/y')).rejects.toMatchObject({
      httpStatus: 410,
    });
  });

  it('uploads media as multipart', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: '555' }));

    expect(
      await provider().uploadMedia({
        phoneNumberId: '1',
        buffer: Buffer.from('hello'),
        mimeType: 'image/png',
        filename: 'a.png',
      }),
    ).toEqual({ mediaId: '555' });

    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBeInstanceOf(FormData);
  });
});

describe('templates and account', () => {
  it('maps the template list and its cursor', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [
          {
            id: '1',
            name: 'proposta',
            language: 'pt_PT',
            status: 'APPROVED',
            category: 'MARKETING',
            quality_score: { score: 'GREEN' },
            components: [{ type: 'BODY', text: 'Olá {{1}}' }],
          },
        ],
        paging: { cursors: { after: 'CURSOR' } },
      }),
    );

    const result = await provider().listTemplates('waba1');

    expect(result.templates[0]).toMatchObject({
      id: '1',
      name: 'proposta',
      qualityScore: 'GREEN',
    });
    expect(result.nextCursor).toBe('CURSOR');
  });

  it('reports no cursor on the last page', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [], paging: {} }));

    expect(await provider().listTemplates('waba1')).toEqual({ templates: [] });
  });

  it('reads the phone number health fields', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        id: '1',
        display_phone_number: '244978735650',
        verified_name: 'Pixel',
        quality_rating: 'GREEN',
        messaging_limit_tier: 'TIER_1K',
        throughput: { level: 'STANDARD' },
      }),
    );

    expect(await provider().getPhoneNumber('1')).toEqual({
      id: '1',
      displayPhoneNumber: '244978735650',
      verifiedName: 'Pixel',
      qualityRating: 'GREEN',
      messagingLimitTier: 'TIER_1K',
      throughputLevel: 'STANDARD',
    });
  });

  /**
   * The step whose absence is invisible: everything in the dashboard looks
   * correct and real messages are silently discarded (confirmed 2026-08-15).
   */
  it('subscribes the app to a WABA', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));

    await provider().subscribeApp('waba1');

    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://graph.facebook.com/v26.0/waba1/subscribed_apps',
    );
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('POST');
  });
});

describe('getProvider', () => {
  it('returns the Cloud API implementation by default', () => {
    delete process.env.WA_PROVIDER;

    expect(getProvider().name).toBe('meta-cloud-api');
  });

  it('memoises within a provider selection', () => {
    expect(getProvider()).toBe(getProvider());
  });

  /** A silent fallback would send real messages through an unselected provider. */
  it('throws on an unknown WA_PROVIDER rather than falling back', () => {
    process.env.WA_PROVIDER = 'TWILIO';

    expect(() => getProvider()).toThrow(/Unknown WA_PROVIDER/);
  });
});
