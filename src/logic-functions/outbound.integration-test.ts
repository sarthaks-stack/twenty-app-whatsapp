import { CoreApiClient } from 'twenty-client-sdk/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The outbound path against a running server (specs/15 task 6.6).
 *
 * **This suite never sends a WhatsApp message, by construction.** Every send it
 * attempts ends in a validation error or a policy denial, so no record is ever
 * left `QUEUED` and the sender is never scheduled. The final test asserts that
 * — a suite that quietly started messaging real numbers because a fixture drifted
 * would be worse than no suite.
 *
 * What it covers that unit tests cannot: that the routes are reachable at the
 * paths the manifest declares, that authentication is enforced before our
 * handler runs, that a missing record produces a 404 rather than a 500 (D-19,
 * which typechecked and passed every unit test while being wrong), and that
 * `clientToken` idempotency reads back a real row.
 */

const API_URL = process.env.TWENTY_API_URL ?? 'http://localhost:2020';
const API_KEY = process.env.TWENTY_API_KEY ?? '';

const client = new CoreApiClient();

const post = async (
  path: string,
  body: unknown,
  { authenticated = true }: { authenticated?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> | string }> => {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: response.status, body: text };
  }
};

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let accountId: string;
let threadId: string;

beforeAll(async () => {
  const account = await client.mutation({
    createWhatsappAccount: {
      __args: {
        data: {
          name: 'Integration test number',
          phoneNumberId: '100000000000001',
          wabaId: '200000000000001',
          // PENDING, so the policy gate's first rule denies every send and
          // nothing can reach Meta even if a later assertion is wrong.
          status: 'PENDING',
        },
      },
      id: true,
    },
  });

  accountId = account.createWhatsappAccount!.id;

  const thread = await client.mutation({
    createWhatsappThread: {
      __args: {
        data: {
          accountId,
          waId: '244900000001',
          dialablePhone: '+244900000001',
          profileName: 'Integration test contact',
          status: 'OPEN',
          windowState: 'OPEN',
          windowKind: 'STANDARD',
          serviceWindowExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          unreadCount: 3,
        },
      },
      id: true,
    },
  });

  threadId = thread.createWhatsappThread!.id;
});

afterAll(async () => {
  const messages = await client.query({
    whatsappMessages: {
      __args: { filter: { threadId: { eq: threadId } }, first: 50 },
      edges: { node: { id: true } },
    },
  });

  for (const edge of messages.whatsappMessages?.edges ?? []) {
    await client.mutation({
      destroyWhatsappMessage: { __args: { id: edge.node.id }, id: true },
    });
  }

  await client.mutation({ destroyWhatsappThread: { __args: { id: threadId }, id: true } });
  await client.mutation({ destroyWhatsappAccount: { __args: { id: accountId }, id: true } });
});

describe('authentication', () => {
  /**
   * The platform rejects a missing token before the handler is entered, which
   * is the property that matters — but it answers `500`, not `401` (specs/04
   * §10.1). Asserted as observed rather than as it ought to be, so that a
   * platform fix shows up here as a failing test rather than as a surprise in
   * a front component.
   */
  it.each([
    ['/s/whatsapp/send'],
    ['/s/whatsapp/thread'],
  ])('rejects an unauthenticated call to %s before the handler runs', async (path) => {
    const response = await post(path, {}, { authenticated: false });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).toContain('authentication token');
  });
});

describe('request validation', () => {
  it('rejects a body with no message', async () => {
    const response = await post('/s/whatsapp/send', { threadId });

    expect(response.status).toBe(400);
  });

  it('rejects an unsupported message kind', async () => {
    const response = await post('/s/whatsapp/send', {
      threadId,
      message: { kind: 'carousel' },
    });

    expect(response.status).toBe(400);
  });
});

describe('missing records answer 404, not 500', () => {
  /**
   * D-19. Twenty's singular record query raises `RECORD_NOT_FOUND` rather than
   * returning null, so the obvious implementation throws where its signature
   * promises absence — and the route answers `500 Internal error`. Nothing in
   * the unit suite could see it.
   */
  it('reports an unknown thread on the send route', async () => {
    const response = await post('/s/whatsapp/send', {
      threadId: MISSING_ID,
      message: { kind: 'text', body: 'probe' },
    });

    expect(response.status).toBe(404);
  });

  it('reports an unknown thread on the actions route', async () => {
    const response = await post('/s/whatsapp/thread', {
      action: 'close',
      threadId: MISSING_ID,
    });

    expect(response.status).toBe(404);
  });

  it('reports an unknown template', async () => {
    const response = await post('/s/whatsapp/send', {
      threadId,
      message: { kind: 'template', templateId: MISSING_ID },
    });

    expect(response.status).toBe(404);
  });
});

describe('the policy gate', () => {
  /**
   * The account is `PENDING`, so rule 1 denies before anything else is
   * considered. A `409` with a machine code is the contract the composer
   * renders localised copy from (specs/01 §7).
   */
  it('denies a send from a number that is not connected', async () => {
    const response = await post('/s/whatsapp/send', {
      threadId,
      message: { kind: 'text', body: 'must not be sent' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'ACCOUNT_NOT_CONNECTED' });
  });

  it('creates no message when it denies', async () => {
    const messages = await client.query({
      whatsappMessages: {
        __args: { filter: { threadId: { eq: threadId } }, first: 10 },
        edges: { node: { id: true } },
      },
    });

    expect(messages.whatsappMessages?.edges ?? []).toHaveLength(0);
  });

  it('denies a blocked thread ahead of anything else it could say', async () => {
    await post('/s/whatsapp/thread', { action: 'block', threadId });

    const response = await post('/s/whatsapp/send', {
      threadId,
      message: { kind: 'text', body: 'must not be sent' },
    });

    await post('/s/whatsapp/thread', { action: 'unblock', threadId });

    /**
     * `ACCOUNT_NOT_CONNECTED` still wins: the evaluation order is normative,
     * and which reason surfaces is part of the contract (specs/04 §1).
     */
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'ACCOUNT_NOT_CONNECTED' });
  });
});

describe('thread actions', () => {
  it('assigns, closes, reopens and blocks', async () => {
    for (const [action, expected] of [
      ['close', { status: 'CLOSED' }],
      ['reopen', { status: 'OPEN' }],
      ['block', { isBlocked: true }],
      ['unblock', { isBlocked: false }],
    ] as const) {
      const response = await post('/s/whatsapp/thread', { action, threadId });

      expect(response.status, action).toBe(200);
      expect(response.body, action).toMatchObject(expected);
    }
  });

  /**
   * Read receipts are off by default (`WA_SEND_READ_RECEIPTS`), so this clears
   * the local count and makes no Meta call — which is what `receiptSent: false`
   * reports.
   */
  it('clears the unread count without telling Meta', async () => {
    const response = await post('/s/whatsapp/thread', { action: 'markRead', threadId });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ receiptSent: false });

    const thread = await client.query({
      whatsappThreads: {
        __args: { filter: { id: { eq: threadId } }, first: 1 },
        edges: { node: { unreadCount: true } },
      },
    });

    expect(thread.whatsappThreads?.edges?.[0]?.node.unreadCount).toBe(0);
  });

  it('rejects an action it does not have', async () => {
    const response = await post('/s/whatsapp/thread', { action: 'explode', threadId });

    expect(response.status).toBe(400);
  });
});

describe('idempotency', () => {
  /**
   * A double-clicked send button arrives as two identical POSTs. The seeded row
   * stands in for the first one — seeded `FAILED` so that nothing can pick it
   * up and try to deliver it.
   */
  const clientToken = 'integration-idempotency-probe';

  it('returns the existing message rather than queueing a second', async () => {
    const seeded = await client.mutation({
      createWhatsappMessage: {
        __args: {
          data: {
            threadId,
            direction: 'OUTBOUND',
            messageType: 'TEXT',
            status: 'FAILED',
            lane: 'INTERACTIVE',
            sourceKind: 'AGENT',
            clientToken,
            body: 'seeded',
            waTimestamp: new Date().toISOString(),
          },
        },
        id: true,
      },
    });

    const response = await post('/s/whatsapp/send', {
      threadId,
      clientToken,
      message: { kind: 'text', body: 'must not be sent twice' },
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ replayed: true });
    expect((response.body as { message?: { id?: string } }).message?.id).toBe(
      seeded.createWhatsappMessage!.id,
    );
  });
});

describe('the suite itself', () => {
  /**
   * The safety net. Every send above was meant to be refused; a message left
   * `QUEUED` means one was accepted and a sender job is scheduled against a
   * real Meta credential.
   */
  it('left nothing queued to send', async () => {
    const queued = await client.query({
      whatsappMessages: {
        __args: {
          filter: { threadId: { eq: threadId }, status: { eq: 'QUEUED' } },
          first: 10,
        },
        edges: { node: { id: true } },
      },
    });

    expect(queued.whatsappMessages?.edges ?? []).toHaveLength(0);
  });
});
