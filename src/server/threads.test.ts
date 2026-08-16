import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Thread linking (FR-CID-2, FR-OUT-5, and the campaign path's consent
 * re-check).
 *
 * These exist because of a defect live verification found and nothing else
 * would have: a campaign created its threads without linking the Person it had
 * just selected from a CRM audience. The visible symptom was mild — a denial
 * reported `NO_CONSENT` for someone who had explicitly opted out — but the
 * cause was that the sender's policy gate reads consent through
 * `thread.personId`, so with no link it read `UNKNOWN`. A **utility** campaign
 * would therefore have sent to someone who opted out while their message sat
 * in the queue, which is precisely what FR-CON-2 forbids.
 */

const findThread = vi.fn();
const createThread = vi.fn();
const patchThread = vi.fn();
const matchPerson = vi.fn();

vi.mock('./repositories/threads', () => ({
  findThread: (...args: unknown[]) => findThread(...args),
  createThread: (...args: unknown[]) => createThread(...args),
  patchThread: (...args: unknown[]) => patchThread(...args),
}));

const patchAccount = vi.fn();

vi.mock('./repositories/accounts', () => ({
  patchAccount: (...args: unknown[]) => patchAccount(...args),
}));

vi.mock('./matching', () => ({ matchPerson: (...args: unknown[]) => matchPerson(...args) }));

const { upsertThread } = await import('./threads');

const account = { id: 'a1', autoAssignStrategy: 'NONE' } as never;

beforeEach(() => {
  findThread.mockReset();
  createThread.mockReset();
  patchThread.mockReset();
  matchPerson.mockReset();
  patchAccount.mockReset();

  createThread.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 't-new',
    ...input,
  }));
});

describe('creating a thread for a known contact', () => {
  it('links the person the caller already identified', async () => {
    findThread.mockResolvedValue(null);

    const { thread, created } = await upsertThread({
      account,
      waId: '244923000111',
      personId: 'p1',
    });

    expect(created).toBe(true);
    expect(thread.personId).toBe('p1');
    // Nothing to resolve: the campaign picked this contact out of the CRM.
    expect(matchPerson).not.toHaveBeenCalled();
  });

  it('still resolves identity for inbound, where nobody knows yet', async () => {
    findThread.mockResolvedValue(null);
    matchPerson.mockResolvedValue({ kind: 'matched', person: { id: 'p-matched' } });

    const { thread } = await upsertThread({
      account,
      waId: '244923000111',
      resolveIdentity: true,
    });

    expect(thread.personId).toBe('p-matched');
  });

  it('leaves an outbound-initiated thread unlinked when nobody knows either', async () => {
    findThread.mockResolvedValue(null);

    const { thread } = await upsertThread({ account, waId: '244923000111' });

    expect(thread.personId).toBeNull();
  });
});

describe('an existing thread', () => {
  it('gets linked when it had no contact', async () => {
    findThread.mockResolvedValue({ id: 't1', waId: '244923000111', personId: null });

    const { thread, created } = await upsertThread({
      account,
      waId: '244923000111',
      personId: 'p1',
    });

    expect(created).toBe(false);
    expect(patchThread).toHaveBeenCalledWith('t1', { personId: 'p1' });
    expect(thread.personId).toBe('p1');
  });

  /**
   * An identity a human decided — or that inbound matching resolved — outranks
   * a caller's assumption. Silently moving a conversation to a different
   * contact is worse than leaving it where it is.
   */
  it('is never re-linked to a different contact', async () => {
    findThread.mockResolvedValue({ id: 't1', waId: '244923000111', personId: 'p-existing' });

    const { thread } = await upsertThread({
      account,
      waId: '244923000111',
      personId: 'p-other',
    });

    expect(patchThread).not.toHaveBeenCalled();
    expect(thread.personId).toBe('p-existing');
  });

  it('writes one patch when both the name and the link change', async () => {
    findThread.mockResolvedValue({
      id: 't1',
      waId: '244923000111',
      personId: null,
      profileName: 'old',
    });

    await upsertThread({
      account,
      waId: '244923000111',
      personId: 'p1',
      profileName: 'Ana',
    });

    expect(patchThread).toHaveBeenCalledTimes(1);
    expect(patchThread).toHaveBeenCalledWith('t1', { profileName: 'Ana', personId: 'p1' });
  });

  /** An unchanged name must not cost a write on every inbound message. */
  it('writes nothing when there is nothing to change', async () => {
    findThread.mockResolvedValue({
      id: 't1',
      waId: '244923000111',
      personId: 'p1',
      profileName: 'Ana',
    });

    await upsertThread({ account, waId: '244923000111', profileName: 'Ana', personId: 'p1' });

    expect(patchThread).not.toHaveBeenCalled();
  });
});

/**
 * D-32's sibling in the thread path. The round-robin cursor write used to sit
 * inside the try that handles the create race, where a failure either got read
 * as a race — reporting a thread we had just created as pre-existing — or
 * rejected the whole upsert *after* the conversation existed, losing the
 * inbound message that made it.
 */
describe('the assignment cursor', () => {
  const roundRobin = {
    id: 'a1',
    autoAssignStrategy: 'ROUND_ROBIN',
    assignmentMemberIds: ['m1', 'm2'],
    lastAssignedIndex: 0,
  } as never;

  it('advances after a thread is created', async () => {
    findThread.mockResolvedValue(null);

    const { thread } = await upsertThread({ account: roundRobin, waId: '244923000111' });

    expect(thread.assigneeId).toBe('m2');
    expect(patchAccount).toHaveBeenCalledWith('a1', { lastAssignedIndex: 1 });
  });

  it('still reports the thread as created when the cursor write fails', async () => {
    findThread.mockResolvedValue(null);
    patchAccount.mockRejectedValue(new Error('500 internal'));

    const result = await upsertThread({ account: roundRobin, waId: '244923000111' });

    expect(result.created).toBe(true);
    expect(result.thread.id).toBe('t-new');
  });

  it('does not mistake a cursor failure for a create race', async () => {
    findThread.mockResolvedValue(null);
    patchAccount.mockRejectedValue(new Error('duplicate key value violates unique constraint'));

    expect((await upsertThread({ account: roundRobin, waId: '244923000111' })).created).toBe(true);
    // The race path re-reads the thread; this is not that path.
    expect(findThread).toHaveBeenCalledTimes(1);
  });
});
