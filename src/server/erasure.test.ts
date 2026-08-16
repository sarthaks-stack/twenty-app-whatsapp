import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Subject erasure (SEC-8, D-24).
 *
 * The defect these were written for: every read took a single page and treated
 * it as the whole set — 200 threads, 1 000 messages, 500 events. A contact with
 * a longer history kept the oldest part of it, and `erasePerson` reported
 * success and wrote a tombstone saying it was gone. An erasure that under-
 * deletes is bad; an erasure that under-deletes *and issues a receipt* is the
 * shape that survives an audit until the day it doesn't.
 *
 * So the fake Core client below pages for real. A one-page implementation
 * cannot pass these; nothing weaker would have caught the original.
 */

type Row = { id: string; mediaFile?: { fileId: string }[] | null };

const store: {
  threads: Row[];
  messages: Row[];
  consentEvents: (Row & { isTombstone?: boolean })[];
  recipients: Row[];
} = { threads: [], messages: [], consentEvents: [], recipients: [] };

/** Rows appended by a "concurrent webhook" the moment a given read happens. */
let onRead: ((collection: string) => void) | null = null;

const COLLECTIONS = {
  whatsappThreads: 'threads',
  whatsappMessages: 'messages',
  whatsappConsentEvents: 'consentEvents',
  whatsappCampaignRecipients: 'recipients',
} as const;

const DESTROYS = {
  destroyWhatsappThreads: 'threads',
  destroyWhatsappMessages: 'messages',
  destroyWhatsappConsentEvents: 'consentEvents',
  destroyWhatsappCampaignRecipients: 'recipients',
} as const;

let reads = 0;

const fakeClient = {
  query: async (selection: Record<string, { __args?: Record<string, unknown> }>) => {
    const key = Object.keys(selection)[0] as keyof typeof COLLECTIONS;
    const args = selection[key].__args ?? {};
    const first = (args.first as number | undefined) ?? 100;
    const after = args.after as string | undefined;

    reads += 1;
    onRead?.(key);

    let rows = store[COLLECTIONS[key]] as (Row & { isTombstone?: boolean })[];

    // The one filter the production code relies on: tombstones are not targets.
    if (key === 'whatsappConsentEvents') rows = rows.filter((row) => row.isTombstone !== true);

    const start = after === undefined ? 0 : Number(after);
    const slice = rows.slice(start, start + first);
    const end = start + slice.length;

    return {
      [key]: {
        edges: slice.map((node) => ({ node })),
        pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) },
      },
    };
  },

  mutation: async (selection: Record<string, { __args?: Record<string, unknown> }>) => {
    const key = Object.keys(selection)[0] as keyof typeof DESTROYS;
    const filter = selection[key].__args?.filter as { id: { in: string[] } };
    const ids = new Set(filter.id.in);
    const name = DESTROYS[key];

    store[name] = store[name].filter((row) => !ids.has(row.id)) as never;

    return { [key]: [...ids].map((id) => ({ id })) };
  },
};

vi.mock('./repositories/base', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./repositories/base')>()),
  query: async (build: (client: unknown) => Promise<unknown>) => build(fakeClient),
}));

const createConsentEvent = vi.fn();
const writeTimelineActivity = vi.fn();
const patchPersonConsent = vi.fn();

vi.mock('./repositories/consent-events', () => ({
  createConsentEvent: (...args: unknown[]) => createConsentEvent(...args),
}));

vi.mock('./repositories/people', () => ({
  findPersonById: async (id: string) => ({ id }),
  patchPersonConsent: (...args: unknown[]) => patchPersonConsent(...args),
}));

vi.mock('./timeline', () => ({
  writeTimelineActivity: (...args: unknown[]) => writeTimelineActivity(...args),
  TIMELINE_EVENT: { DATA_ERASED: 'DATA_ERASED' },
}));

const { collectErasureTargets, erasePerson, ErasureIncompleteError, ERASURE_PAGE_SIZE } =
  await import('./erasure');

const rows = (prefix: string, count: number, withMedia = 0): Row[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    mediaFile: index < withMedia ? [{ fileId: `f-${index}` }] : null,
  }));

const seed = ({
  threads = 1,
  messages = 0,
  consentEvents = 0,
  recipients = 0,
  media = 0,
}: {
  threads?: number;
  messages?: number;
  consentEvents?: number;
  recipients?: number;
  media?: number;
}) => {
  store.threads = rows('t', threads);
  store.messages = rows('m', messages, media);
  store.consentEvents = rows('c', consentEvents);
  store.recipients = rows('r', recipients);
};

beforeEach(() => {
  reads = 0;
  onRead = null;
  createConsentEvent.mockReset();
  writeTimelineActivity.mockReset();
  patchPersonConsent.mockReset();
  seed({});
});

describe('enumerating what an erasure would touch', () => {
  it('reads past the first page of every collection', async () => {
    seed({
      threads: ERASURE_PAGE_SIZE + 7,
      messages: ERASURE_PAGE_SIZE * 4 + 3,
      consentEvents: ERASURE_PAGE_SIZE + 1,
      recipients: ERASURE_PAGE_SIZE * 2,
    });

    const targets = await collectErasureTargets('p1');

    expect(targets.threadIds).toHaveLength(ERASURE_PAGE_SIZE + 7);
    expect(targets.messageIds).toHaveLength(ERASURE_PAGE_SIZE * 4 + 3);
    expect(targets.consentEventIds).toHaveLength(ERASURE_PAGE_SIZE + 1);
    expect(targets.recipientIds).toHaveLength(ERASURE_PAGE_SIZE * 2);
  });

  it('counts every distinct id exactly once across pages', async () => {
    seed({ messages: ERASURE_PAGE_SIZE * 3 + 11 });

    const { messageIds } = await collectErasureTargets('p1');

    expect(new Set(messageIds).size).toBe(messageIds.length);
  });

  it('counts media attachments from every page, not just the first', async () => {
    seed({ messages: ERASURE_PAGE_SIZE * 2, media: ERASURE_PAGE_SIZE + 5 });

    expect((await collectErasureTargets('p1')).mediaFileCount).toBe(ERASURE_PAGE_SIZE + 5);
  });

  it('does not read messages at all when the person has no threads', async () => {
    seed({ threads: 0, messages: 5 });

    const targets = await collectErasureTargets('p1');

    expect(targets.messageIds).toEqual([]);
  });

  it('leaves an earlier erasure tombstone out of the targets', async () => {
    seed({ consentEvents: 3 });
    store.consentEvents.push({ id: 'tombstone-1', isTombstone: true });

    expect((await collectErasureTargets('p1')).consentEventIds).not.toContain('tombstone-1');
  });
});

describe('the dry run', () => {
  it('reports the true totals, not a page of them', async () => {
    seed({ threads: 2, messages: 2_500, consentEvents: 900, recipients: 700 });

    const result = await erasePerson({ personId: 'p1', actorId: 'a1', dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      threads: 2,
      messages: 2_500,
      consentEvents: 900,
      campaignRecipients: 700,
    });
  });

  it('deletes nothing and records nothing', async () => {
    seed({ messages: 400 });

    await erasePerson({ personId: 'p1', actorId: 'a1', dryRun: true });

    expect(store.messages).toHaveLength(400);
    expect(createConsentEvent).not.toHaveBeenCalled();
    expect(writeTimelineActivity).not.toHaveBeenCalled();
  });
});

describe('erasing', () => {
  it('removes every record, including the ones past the first page', async () => {
    seed({ threads: 3, messages: 2_500, consentEvents: 900, recipients: 700 });

    const result = await erasePerson({ personId: 'p1', actorId: 'a1' });

    expect(store).toMatchObject({ threads: [], messages: [], consentEvents: [], recipients: [] });
    expect(result).toMatchObject({
      dryRun: false,
      threads: 3,
      messages: 2_500,
      consentEvents: 900,
      campaignRecipients: 700,
    });
  });

  it('writes the tombstone with the counts it actually deleted', async () => {
    seed({ threads: 2, messages: 1_400, consentEvents: 3 });

    await erasePerson({ personId: 'p1', actorId: 'a1' });

    expect(createConsentEvent).toHaveBeenCalledTimes(1);
    expect(createConsentEvent.mock.calls[0][0]).toMatchObject({
      personId: 'p1',
      actorId: 'a1',
      isTombstone: true,
      notes: 'Erased 3 consent events, 1400 messages and 2 conversations',
    });
  });

  /**
   * The events behind the status are gone, so a Person left `OPTED_IN` would
   * be an unauditable claim — and would keep an "erased" contact selectable
   * for the next campaign.
   */
  it('resets the person’s denormalised consent status with the evidence', async () => {
    seed({ consentEvents: 3 });

    await erasePerson({ personId: 'p1', actorId: 'a1' });

    expect(patchPersonConsent).toHaveBeenCalledTimes(1);
    expect(patchPersonConsent.mock.calls[0][0]).toBe('p1');
    expect(patchPersonConsent.mock.calls[0][1]).toBe('UNKNOWN');
  });

  it('does not touch the person’s consent status on a dry run', async () => {
    seed({ consentEvents: 3 });

    await erasePerson({ personId: 'p1', actorId: 'a1', dryRun: true });

    expect(patchPersonConsent).not.toHaveBeenCalled();
  });

  it('carries no content into the tombstone', async () => {
    seed({ messages: 5 });

    await erasePerson({ personId: 'p1', actorId: 'a1' });

    expect(createConsentEvent.mock.calls[0][0]).toMatchObject({
      wordingShown: null,
      sourceReference: null,
      newStatus: null,
      previousStatus: null,
    });
  });

  it('picks up a record that arrived while it was deleting', async () => {
    seed({ threads: 1, messages: 10 });

    let fired = false;

    // A webhook writes an inbound message after the first enumeration.
    onRead = () => {
      if (fired) return;

      fired = true;
      store.messages.push({ id: 'm-late', mediaFile: null });
    };

    const result = await erasePerson({ personId: 'p1', actorId: 'a1' });

    expect(store.messages).toEqual([]);
    expect(result.messages).toBe(11);
    expect(createConsentEvent).toHaveBeenCalledTimes(1);
  });

  it('refuses to report success when records keep appearing', async () => {
    seed({ threads: 1, messages: 2 });

    // A pathological writer: a new event lands every time we look.
    let seq = 0;

    onRead = (collection) => {
      if (collection !== 'whatsappConsentEvents') return;

      seq += 1;
      store.consentEvents.push({ id: `c-loop-${seq}` });
    };

    await expect(erasePerson({ personId: 'p1', actorId: 'a1' })).rejects.toBeInstanceOf(
      ErasureIncompleteError,
    );

    // No receipt of any kind for an erasure that could not finish.
    expect(createConsentEvent).not.toHaveBeenCalled();
    expect(writeTimelineActivity).not.toHaveBeenCalled();
  });

  it('deletes messages before the threads that hold them', async () => {
    seed({ threads: 1, messages: 3 });

    const order: string[] = [];
    const original = fakeClient.mutation;

    fakeClient.mutation = async (selection) => {
      order.push(Object.keys(selection)[0]);

      return original(selection);
    };

    try {
      await erasePerson({ personId: 'p1', actorId: 'a1' });
    } finally {
      fakeClient.mutation = original;
    }

    expect(order.indexOf('destroyWhatsappMessages')).toBeLessThan(
      order.indexOf('destroyWhatsappThreads'),
    );
  });

  it('keeps the tombstone of an earlier erasure', async () => {
    seed({ consentEvents: 2 });
    store.consentEvents.push({ id: 'tombstone-1', isTombstone: true });

    await erasePerson({ personId: 'p1', actorId: 'a1' });

    expect(store.consentEvents.map((row) => row.id)).toEqual(['tombstone-1']);
  });
});
