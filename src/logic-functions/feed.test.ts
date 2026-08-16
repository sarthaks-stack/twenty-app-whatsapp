import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The feed route (specs/08 §2, D-6).
 *
 * Every front component reads through this one handler, so a mistake here is a
 * mistake on five surfaces at once. Three properties are worth defending with
 * a fake that actually filters, orders and pages:
 *
 * 1. **`policy` is the server's answer, not a hint.** The composer renders
 *    whatever this says (AR-17); if the route computed it differently from the
 *    send route, the button would be enabled for a send that will be refused.
 * 2. **A delta never loses a row.** `nextSince` is the client's only memory of
 *    where it got to. Advancing it past rows that were not returned is the one
 *    bug in a polling transport that never self-corrects.
 * 3. **A filter means what it says.** `mine` must not silently become `all`.
 */

type Row = Record<string, unknown>;

const store: Record<string, Row[]> = {
  whatsappThreads: [],
  whatsappMessages: [],
  whatsappAccounts: [],
  whatsappTemplates: [],
  whatsappCampaigns: [],
  whatsappCampaignRecipients: [],
  people: [],
};

/** Every `__args.filter` the route sent, so a test can assert on the query itself. */
let filters: { collection: string; filter: Record<string, Row> }[] = [];

const matches = (row: Row, filter: Record<string, Row> | undefined): boolean => {
  if (filter === undefined) return true;

  return Object.entries(filter).every(([field, condition]) => {
    const value = row[field] ?? null;

    return Object.entries(condition).every(([operator, operand]) => {
      switch (operator) {
        case 'eq':
          return value === operand;
        case 'neq':
          return value !== operand;
        case 'in':
          return (operand as unknown[]).includes(value);
        case 'is':
          return operand === 'NULL' ? value === null : value !== null;
        case 'gte':
          return value !== null && (value as string) >= (operand as string);
        case 'lte':
          return value !== null && (value as string) <= (operand as string);
        case 'gt':
          return value !== null && (value as string) > (operand as string);
        case 'lt':
          return value !== null && (value as string) < (operand as string);
        default:
          // A fake that quietly ignored an operator would let a broken filter
          // pass as a working one.
          throw new Error(`fake client: unsupported operator ${operator}`);
      }
    });
  });
};

const sorted = (rows: Row[], orderBy: Record<string, string>[] | undefined): Row[] => {
  if (orderBy === undefined || orderBy.length === 0) return rows;

  const [field, direction] = Object.entries(orderBy[0])[0];

  return [...rows].sort((left, right) => {
    const a = (left[field] ?? '') as string;
    const b = (right[field] ?? '') as string;
    const order = a < b ? -1 : a > b ? 1 : 0;

    return direction.startsWith('Desc') ? -order : order;
  });
};

const fakeClient = {
  query: async (selection: Record<string, { __args?: Record<string, unknown> }>) => {
    const answer: Record<string, unknown> = {};

    for (const [collection, node] of Object.entries(selection)) {
      const args = node.__args ?? {};
      const filter = args.filter as Record<string, Row> | undefined;

      filters.push({ collection, filter: filter ?? {} });

      const rows = sorted(
        (store[collection] ?? []).filter((row) => matches(row, filter)),
        args.orderBy as Record<string, string>[] | undefined,
      );

      const start = args.after === undefined ? 0 : Number(args.after);
      const first = (args.first as number | undefined) ?? 50;
      const slice = rows.slice(start, start + first);
      const end = start + slice.length;

      answer[collection] = {
        edges: slice.map((row) => ({ node: row })),
        totalCount: rows.length,
        pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) },
      };
    }

    return answer;
  },
};

vi.mock('../server/repositories/base', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/repositories/base')>()),
  query: async (build: (client: unknown) => Promise<unknown>) => build(fakeClient),
}));

let caller: import('../server/auth').Caller = {
  userWorkspaceId: 'uw-1',
  workspaceMemberId: 'wm-1',
  roleUniversalIdentifiers: [],
  isAdmin: false,
  isAgent: true,
  isMachine: false,
};

vi.mock('../server/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/auth')>()),
  requireCaller: async () => caller,
}));

const { handler } = await import('./wa-inbox-feed-route');

type Envelope = Record<string, any>;

const call = async (
  params: Record<string, string>,
): Promise<{ status: number; body: Envelope }> => {
  const response = (await handler({
    headers: {},
    queryStringParameters: params,
    pathParameters: {},
    body: null,
    isBase64Encoded: false,
    requestContext: { http: { method: 'GET', path: '/whatsapp/feed' } },
    userWorkspaceId: 'uw-1',
  } as never)) as unknown as { status?: number; body: Envelope };

  return { status: response.status ?? 200, body: response.body };
};

const HOUR = 60 * 60 * 1000;

const seedAccount = (overrides: Row = {}): Row => {
  const account = {
    id: 'acc-1',
    name: 'Main',
    status: 'CONNECTED',
    qualityRating: 'GREEN',
    isTestAccount: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };

  store.whatsappAccounts.push(account);

  return account;
};

const seedThread = (overrides: Row = {}): Row => {
  const thread = {
    id: 'thr-1',
    accountId: 'acc-1',
    waId: '244900000001',
    profileName: 'Ana',
    status: 'OPEN',
    windowState: 'OPEN',
    serviceWindowExpiresAt: new Date(Date.now() + 4 * HOUR).toISOString(),
    lastMessageAt: '2026-08-16T12:00:00.000Z',
    isBlocked: false,
    ...overrides,
  };

  store.whatsappThreads.push(thread);

  return thread;
};

const seedMessage = (overrides: Row = {}): Row => {
  const index = store.whatsappMessages.length;
  const message = {
    id: `msg-${index}`,
    threadId: 'thr-1',
    direction: 'INBOUND',
    messageType: 'TEXT',
    status: 'DELIVERED',
    body: `message ${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 16, 10, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 7, 16, 10, index)).toISOString(),
    ...overrides,
  };

  store.whatsappMessages.push(message);

  return message;
};

beforeEach(() => {
  for (const key of Object.keys(store)) store[key] = [];
  filters = [];
  caller = {
    userWorkspaceId: 'uw-1',
    workspaceMemberId: 'wm-1',
    roleUniversalIdentifiers: [],
    isAdmin: false,
    isAgent: true,
    isMachine: false,
  };
});

describe('scope=thread', () => {
  it('returns the newest messages first, with the account and the person', async () => {
    seedAccount();
    seedThread({ personId: 'p-1' });
    store.people.push({
      id: 'p-1',
      name: { firstName: 'Ana', lastName: 'Silva' },
      phones: { primaryPhoneNumber: '900000001', primaryPhoneCallingCode: '+244' },
      whatsappOptInStatus: 'OPTED_IN',
    });
    for (let i = 0; i < 3; i += 1) seedMessage();

    const { status, body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(status).toBe(200);
    expect(body.messages.map((message: Envelope) => message.body)).toEqual([
      'message 2',
      'message 1',
      'message 0',
    ]);
    expect(body.account.name).toBe('Main');
    expect(body.thread.person).toMatchObject({
      firstName: 'Ana',
      primaryPhone: '+244900000001',
    });
  });

  it('computes the composer state server-side — open window', async () => {
    seedAccount();
    seedThread();

    const { body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(body.policy).toEqual({ allowed: true, reason: null, warnings: [] });
  });

  it('answers WINDOW_CLOSED, which is what swaps in the template button', async () => {
    seedAccount();
    seedThread({ serviceWindowExpiresAt: new Date(Date.now() - HOUR).toISOString() });

    const { body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(body.policy).toMatchObject({ allowed: false, reason: 'WINDOW_CLOSED' });
  });

  it('reports the window closing as a warning without disabling the composer', async () => {
    seedAccount();
    seedThread({ serviceWindowExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });

    const { body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(body.policy.allowed).toBe(true);
    expect(body.policy.warnings).toContain('WINDOW_EXPIRING_SOON');
  });

  it('sends the template catalogue on a full load and never on a delta', async () => {
    seedAccount();
    seedThread();
    store.whatsappTemplates.push(
      {
        id: 'tpl-1',
        accountId: 'acc-1',
        name: 'boas_vindas',
        status: 'APPROVED',
        publishedToCrm: true,
        isUsableInCrm: true,
      },
      {
        id: 'tpl-2',
        accountId: 'acc-1',
        name: 'rascunho',
        status: 'APPROVED',
        publishedToCrm: false,
        isUsableInCrm: true,
      },
    );

    const full = await call({ scope: 'thread', id: 'thr-1' });

    // Only the published, usable one — the picker is not asked to re-derive
    // FR-TPL-2 in the browser.
    expect(full.body.templates.map((template: Envelope) => template.id)).toEqual(['tpl-1']);

    const delta = await call({
      scope: 'thread',
      id: 'thr-1',
      since: '2026-08-16T00:00:00.000Z',
    });

    expect(delta.body.templates).toBeUndefined();
  });

  it('returns only what changed since the cursor', async () => {
    seedAccount();
    seedThread();
    seedMessage({ updatedAt: '2026-08-16T09:00:00.000Z' });
    seedMessage({ updatedAt: '2026-08-16T11:00:00.000Z' });

    const { body } = await call({
      scope: 'thread',
      id: 'thr-1',
      since: '2026-08-16T10:00:00.000Z',
    });

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].body).toBe('message 1');
  });

  it('re-sends the boundary row rather than risking a gap', async () => {
    seedAccount();
    seedThread();
    seedMessage({ updatedAt: '2026-08-16T10:00:00.000Z' });

    const { body } = await call({
      scope: 'thread',
      id: 'thr-1',
      since: '2026-08-16T10:00:00.000Z',
    });

    expect(body.messages).toHaveLength(1);
  });

  it('walks a burst through instead of skipping past it', async () => {
    seedAccount();
    seedThread();
    // One more than a delta page: the honest answer is "here is as far as I
    // got", not "you are up to date".
    for (let i = 0; i < 201; i += 1) {
      seedMessage({ updatedAt: new Date(Date.UTC(2026, 7, 16, 10, 0, i)).toISOString() });
    }

    const { body } = await call({
      scope: 'thread',
      id: 'thr-1',
      since: '2026-08-16T00:00:00.000Z',
    });

    expect(body.messages).toHaveLength(200);
    expect(body.truncated).toBe(true);
    // The 200th row's timestamp, not the wall clock — the 201st must still be
    // reachable on the next poll.
    expect(body.nextSince).toBe(new Date(Date.UTC(2026, 7, 16, 10, 0, 199)).toISOString());
    expect(new Date(body.nextSince).getTime()).toBeLessThan(
      new Date(body.serverTime).getTime(),
    );
  });

  it('advances the cursor to the clock when the delta fitted', async () => {
    seedAccount();
    seedThread();
    seedMessage();

    const { body } = await call({
      scope: 'thread',
      id: 'thr-1',
      since: '2026-08-16T00:00:00.000Z',
    });

    expect(body.truncated).toBeUndefined();
    expect(body.nextSince).toBe(body.serverTime);
  });

  it('404s an unknown thread', async () => {
    seedAccount();

    expect(await call({ scope: 'thread', id: 'nope' })).toMatchObject({ status: 404 });
  });

  it('treats a Person with no conversation as an empty state, not a failure', async () => {
    seedAccount();

    const { status, body } = await call({ scope: 'thread', id: 'p-9', by: 'person' });

    expect(status).toBe(200);
    expect(body.thread).toBeNull();
    expect(body.messages).toEqual([]);
    // The picker still arrives, because "Iniciar conversa" is a template send.
    expect(body.templates).toEqual([]);
  });

  it('resolves the Person’s most recent conversation when there are two', async () => {
    seedAccount();
    seedThread({ id: 'old', personId: 'p-1', lastMessageAt: '2026-01-01T00:00:00.000Z' });
    seedThread({ id: 'new', personId: 'p-1', lastMessageAt: '2026-08-16T00:00:00.000Z' });

    const { body } = await call({ scope: 'thread', id: 'p-1', by: 'person' });

    expect(body.thread.id).toBe('new');
  });
});

describe('scope=inbox', () => {
  const seedFour = () => {
    seedAccount();
    seedThread({ id: 'mine', assigneeId: 'wm-1' });
    seedThread({ id: 'theirs', assigneeId: 'wm-2' });
    seedThread({ id: 'nobody', assigneeId: null });
    seedThread({ id: 'done', assigneeId: 'wm-1', status: 'CLOSED' });
  };

  it('mine means mine', async () => {
    seedFour();

    const { body } = await call({ scope: 'inbox', filter: 'mine' });

    expect(body.threads.map((thread: Envelope) => thread.id)).toEqual(['mine']);
  });

  it('unassigned means unassigned', async () => {
    seedFour();

    const { body } = await call({ scope: 'inbox', filter: 'unassigned' });

    expect(body.threads.map((thread: Envelope) => thread.id)).toEqual(['nobody']);
  });

  it('hides closed conversations from every filter but one', async () => {
    seedFour();

    const all = await call({ scope: 'inbox', filter: 'all' });

    expect(all.body.threads.map((thread: Envelope) => thread.id)).not.toContain('done');

    const closed = await call({ scope: 'inbox', filter: 'closed' });

    expect(closed.body.threads.map((thread: Envelope) => thread.id)).toEqual(['done']);
  });

  it('window_expiring excludes windows that already closed', async () => {
    seedAccount();
    seedThread({
      id: 'soon',
      serviceWindowExpiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    seedThread({
      id: 'gone',
      serviceWindowExpiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    seedThread({
      id: 'plenty',
      serviceWindowExpiresAt: new Date(Date.now() + 20 * HOUR).toISOString(),
    });

    const { body } = await call({ scope: 'inbox', filter: 'window_expiring' });

    expect(body.threads.map((thread: Envelope) => thread.id)).toEqual(['soon']);
  });

  it('orders by last activity, newest first', async () => {
    seedAccount();
    seedThread({ id: 'stale', lastMessageAt: '2026-08-01T00:00:00.000Z' });
    seedThread({ id: 'fresh', lastMessageAt: '2026-08-16T00:00:00.000Z' });

    const { body } = await call({ scope: 'inbox', filter: 'all' });

    expect(body.threads.map((thread: Envelope) => thread.id)).toEqual(['fresh', 'stale']);
  });

  it('refuses filter=mine for a caller with no workspace member', async () => {
    seedFour();
    caller = { ...caller, workspaceMemberId: null, isMachine: true };

    const { status } = await call({ scope: 'inbox', filter: 'mine' });

    // Answering "here is everything" to "show me mine" is the wrong answer to
    // a question about ownership.
    expect(status).toBe(400);
  });

  it('refuses an unknown filter', async () => {
    seedFour();

    expect(await call({ scope: 'inbox', filter: 'urgent' })).toMatchObject({ status: 400 });
  });
});

describe('permissions', () => {
  it('an agent may send but not manage templates or campaigns', async () => {
    seedAccount();

    const { body } = await call({ scope: 'bootstrap' });

    expect(body.permissions).toEqual({
      canSend: true,
      canManageTemplates: false,
      canManageCampaigns: false,
      workspaceMemberId: 'wm-1',
    });
  });

  it('an admin may do all three', async () => {
    seedAccount();
    caller = { ...caller, isAdmin: true };

    const { body } = await call({ scope: 'bootstrap' });

    expect(body.permissions).toEqual({
      canSend: true,
      canManageTemplates: true,
      canManageCampaigns: true,
      workspaceMemberId: 'wm-1',
    });
  });
});

describe('the account block', () => {
  it('never carries the routing identity of the number', async () => {
    seedAccount({ phoneNumberId: '123456789012345', wabaId: '987654321' });

    const { body } = await call({ scope: 'bootstrap' });

    expect(body.account.phoneNumberId).toBeUndefined();
    expect(body.account.wabaId).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('123456789012345');
  });

  it('prefers a connected number over a pending one', async () => {
    seedAccount({ id: 'pending', status: 'PENDING', createdAt: '2026-01-01T00:00:00.000Z' });
    seedAccount({ id: 'live', status: 'CONNECTED', createdAt: '2026-02-01T00:00:00.000Z' });

    const { body } = await call({ scope: 'bootstrap' });

    expect(body.account.id).toBe('live');
  });

  it('still shows a pending number rather than nothing at all', async () => {
    seedAccount({ id: 'pending', status: 'PENDING' });

    const { body } = await call({ scope: 'bootstrap' });

    expect(body.account.id).toBe('pending');
  });
});

describe('scope=campaign', () => {
  it('lists campaigns when no id is given', async () => {
    seedAccount();
    store.whatsappCampaigns.push(
      { id: 'c-1', name: 'Old', status: 'COMPLETED', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'c-2', name: 'New', status: 'RUNNING', createdAt: '2026-08-01T00:00:00.000Z' },
    );

    const { body } = await call({ scope: 'campaign' });

    expect(body.campaigns.map((campaign: Envelope) => campaign.id)).toEqual(['c-2', 'c-1']);
  });

  it('returns one campaign with a recipient sample', async () => {
    seedAccount();
    store.whatsappCampaigns.push({ id: 'c-1', name: 'Promo', accountId: 'acc-1' });
    store.whatsappCampaignRecipients.push(
      { id: 'r-1', campaignId: 'c-1', status: 'SENT' },
      { id: 'r-2', campaignId: 'c-2', status: 'SENT' },
    );

    const { body } = await call({ scope: 'campaign', id: 'c-1' });

    expect(body.campaign.name).toBe('Promo');
    expect(body.recipients.map((recipient: Envelope) => recipient.id)).toEqual(['r-1']);
  });

  it('404s an unknown campaign', async () => {
    seedAccount();

    expect(await call({ scope: 'campaign', id: 'nope' })).toMatchObject({ status: 404 });
  });
});
