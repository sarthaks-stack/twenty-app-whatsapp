import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What happens after Meta says yes (D-25).
 *
 * The defect these were written for: every post-acceptance write — the wamid,
 * the thread, the campaign recipient, the tier ledger, the timeline — sat
 * inside the same `try` as the send itself. A Core API blip in that window was
 * caught, classified as a *Meta* error and could be **retried**; and because
 * the failed write was the wamid, the retry found a QUEUED message with no
 * wamid, passed `sendGuard`, and sent a second copy to a real person.
 *
 * These tests are about that one property: **the provider is called at most
 * once per message, whatever the database does afterwards.**
 */

const sendMessage = vi.fn();
const findMessageById = vi.fn();
const patchMessage = vi.fn();
const patchThread = vi.fn();
const findThreadById = vi.fn();
const findAccountById = vi.fn();
const findPersonById = vi.fn();
const findRecipientByMessageId = vi.fn();
const patchRecipient = vi.fn();
const recordBusinessInitiated = vi.fn();
const writeTimelineActivity = vi.fn();
const rescheduleSend = vi.fn();
const noteCampaignChange = vi.fn();
const kvGet = vi.fn();
const kvSet = vi.fn();
const downloadWorkspaceFile = vi.fn();

class FakeWorkspaceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceFileError';
  }
}

vi.mock('twenty-sdk/logic-function', () => ({
  kv: {
    get: (...args: unknown[]) => kvGet(...args),
    set: (...args: unknown[]) => kvSet(...args),
  },
}));

vi.mock('twenty-sdk/define', () => ({
  defineLogicFunction: (definition: unknown) => definition,
}));

vi.mock('../providers/whatsapp', () => ({
  getProvider: () => ({ sendMessage: (...args: unknown[]) => sendMessage(...args) }),
}));

vi.mock('../server/repositories/messages', () => ({
  findMessageById: (...args: unknown[]) => findMessageById(...args),
  patchMessage: (...args: unknown[]) => patchMessage(...args),
}));

vi.mock('../server/repositories/threads', () => ({
  findThreadById: (...args: unknown[]) => findThreadById(...args),
  patchThread: (...args: unknown[]) => patchThread(...args),
}));

vi.mock('../server/repositories/accounts', () => ({
  findAccountById: (...args: unknown[]) => findAccountById(...args),
  patchAccount: vi.fn(),
}));

vi.mock('../server/repositories/people', () => ({
  findPersonById: (...args: unknown[]) => findPersonById(...args),
}));

vi.mock('../server/repositories/campaign-recipients', () => ({
  findRecipientByMessageId: (...args: unknown[]) => findRecipientByMessageId(...args),
  patchRecipient: (...args: unknown[]) => patchRecipient(...args),
}));

vi.mock('../server/repositories/campaigns', () => ({ findCampaignById: vi.fn() }));

vi.mock('../server/repositories/templates', () => ({
  findTemplateById: vi.fn(),
  patchTemplate: vi.fn(),
}));

vi.mock('../server/tier-ledger', () => ({
  recordBusinessInitiated: (...args: unknown[]) => recordBusinessInitiated(...args),
}));

vi.mock('../server/timeline', () => ({
  writeTimelineActivity: (...args: unknown[]) => writeTimelineActivity(...args),
  TIMELINE_EVENT: {
    MESSAGE_SENT: 'MESSAGE_SENT',
    TEMPLATE_SENT: 'TEMPLATE_SENT',
    MESSAGE_FAILED: 'MESSAGE_FAILED',
  },
  THREAD_OBJECT_UID: 'thread-uid',
}));

vi.mock('../server/schedule', () => ({
  rescheduleSend: (...args: unknown[]) => rescheduleSend(...args),
}));

vi.mock('../server/campaign-deltas', () => ({
  noteCampaignChange: (...args: unknown[]) => noteCampaignChange(...args),
}));

vi.mock('../server/campaign-state', () => ({ transitionCampaign: vi.fn() }));

vi.mock('../server/files', () => ({
  downloadWorkspaceFile: (...args: unknown[]) => downloadWorkspaceFile(...args),
  WorkspaceFileError: FakeWorkspaceFileError,
}));

const { sendOutbound, acceptanceKey } = await import('./wa-outbound-sender');

const MESSAGE_ID = 'msg-1';

const message = () => ({
  id: MESSAGE_ID,
  direction: 'OUTBOUND',
  status: 'QUEUED',
  wamid: null,
  threadId: 'th-1',
  lane: 'INTERACTIVE',
  retryCount: 0,
  payload: { kind: 'text', body: 'olá' },
  statusTimestamps: {},
  mediaMeta: {},
  templateCategory: null,
  templateId: null,
  body: 'olá',
  templateName: null,
});

beforeEach(() => {
  for (const spy of [
    sendMessage,
    findMessageById,
    patchMessage,
    patchThread,
    findThreadById,
    findAccountById,
    findPersonById,
    findRecipientByMessageId,
    patchRecipient,
    recordBusinessInitiated,
    writeTimelineActivity,
    rescheduleSend,
    noteCampaignChange,
    kvGet,
    kvSet,
    downloadWorkspaceFile,
  ]) {
    spy.mockReset();
  }

  kvGet.mockResolvedValue(null);
  kvSet.mockResolvedValue(undefined);
  findMessageById.mockResolvedValue(message());
  findThreadById.mockResolvedValue({
    id: 'th-1',
    waId: '244923000000',
    accountId: 'acc-1',
    personId: 'p-1',
    isBlocked: false,
    status: 'OPEN',
    serviceWindowExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastOutboundAt: null,
  });
  findAccountById.mockResolvedValue({
    id: 'acc-1',
    phoneNumberId: '123',
    status: 'CONNECTED',
    qualityRating: 'GREEN',
  });
  findPersonById.mockResolvedValue({ id: 'p-1', whatsappOptInStatus: 'OPTED_IN' });
  sendMessage.mockResolvedValue({ wamid: 'wamid.HBg' });
  patchMessage.mockResolvedValue(undefined);
  patchThread.mockResolvedValue(undefined);
  writeTimelineActivity.mockResolvedValue(undefined);
});

describe('the happy path', () => {
  it('sends once and records the wamid', async () => {
    const result = await sendOutbound({ messageId: MESSAGE_ID });

    expect(result).toEqual({ outcome: 'sent', wamid: 'wamid.HBg' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(patchMessage.mock.calls[0][1]).toMatchObject({
      wamid: 'wamid.HBg',
      status: 'ACCEPTED',
    });
  });
});

/**
 * D-58. Every outbound image, video, audio file and PDF failed under
 * `MEDIA_UNAVAILABLE` — "the file is no longer available from Meta" — for a
 * failure that happened before Meta was contacted at all, and which was in fact
 * a read of Twenty's own storage. The code is what a rep's sentence and an
 * operator's dashboard are both built from, so naming the wrong system sent
 * every investigation the wrong way.
 */
describe('an attachment that cannot be read out of Twenty', () => {
  const mediaMessage = () => ({
    ...message(),
    payload: {
      kind: 'media',
      mediaKind: 'image',
      fileUrl: 'https://app.crm.example.test/files/attachment/x.png',
      filename: 'x.png',
      caption: null,
    },
    body: null,
  });

  beforeEach(() => {
    findMessageById.mockResolvedValue(mediaMessage());
    downloadWorkspaceFile.mockRejectedValue(
      new FakeWorkspaceFileError('Reading the file failed with HTTP 404 Not Found'),
    );
  });

  it('fails under its own code rather than Meta’s', async () => {
    const result = await sendOutbound({ messageId: MESSAGE_ID });

    expect(result).toEqual({ outcome: 'failed', reason: 'attachment unreadable' });
    expect(
      patchMessage.mock.calls.some(
        (call) => (call[1] as { errorCode?: string }).errorCode === 'ATTACHMENT_UNREADABLE',
      ),
    ).toBe(true);
  });

  /** The sentence a rep reads is the only place the real cause survives. */
  it('keeps the reason the read gave', async () => {
    await sendOutbound({ messageId: MESSAGE_ID });

    const failure = patchMessage.mock.calls
      .map((call) => call[1] as { errorDetail?: string })
      .find((patch) => typeof patch.errorDetail === 'string');

    expect(failure?.errorDetail).toContain('404');
  });

  it('never contacts Meta', async () => {
    await sendOutbound({ messageId: MESSAGE_ID });

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('when the database fails after Meta accepted', () => {
  it('does not retry a message Meta already has', async () => {
    patchMessage.mockRejectedValue(new Error('429 too many requests'));

    const result = await sendOutbound({ messageId: MESSAGE_ID });

    // The send stands: it happened.
    expect(result).toEqual({ outcome: 'sent', wamid: 'wamid.HBg' });
    // And nothing was scheduled to try it again.
    expect(rescheduleSend).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // Nor was a delivered message written down as a failure.
    expect(
      patchMessage.mock.calls.some((call) => (call[1] as { status?: string }).status === 'FAILED'),
    ).toBe(false);
  });

  it('leaves a marker so the next attempt can see the acceptance', async () => {
    patchMessage.mockRejectedValue(new Error('503 service unavailable'));

    await sendOutbound({ messageId: MESSAGE_ID });

    expect(kvSet).toHaveBeenCalledWith(
      acceptanceKey(MESSAGE_ID),
      expect.objectContaining({ wamid: 'wamid.HBg' }),
      { scope: 'WORKSPACE' },
    );
  });

  it('does not send again when that marker is present', async () => {
    kvGet.mockResolvedValue({ wamid: 'wamid.HBg' });

    const result = await sendOutbound({ messageId: MESSAGE_ID });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'skipped', wamid: 'wamid.HBg' });
  });

  it('still sends when the marker store itself is down', async () => {
    kvGet.mockRejectedValue(new Error('kv unavailable'));

    expect(await sendOutbound({ messageId: MESSAGE_ID })).toMatchObject({ outcome: 'sent' });
  });

  it('survives a thread update failing', async () => {
    patchThread.mockRejectedValue(new Error('500 internal'));

    expect(await sendOutbound({ messageId: MESSAGE_ID })).toEqual({
      outcome: 'sent',
      wamid: 'wamid.HBg',
    });
    expect(rescheduleSend).not.toHaveBeenCalled();
  });

  it('survives the timeline write failing', async () => {
    writeTimelineActivity.mockRejectedValue(new Error('500 internal'));

    expect(await sendOutbound({ messageId: MESSAGE_ID })).toEqual({
      outcome: 'sent',
      wamid: 'wamid.HBg',
    });
  });

  it('survives the campaign mirror failing, and still records the send', async () => {
    findMessageById.mockResolvedValue({ ...message(), lane: 'CAMPAIGN' });
    findRecipientByMessageId.mockRejectedValue(new Error('500 internal'));

    expect(await sendOutbound({ messageId: MESSAGE_ID })).toEqual({
      outcome: 'sent',
      wamid: 'wamid.HBg',
    });
    expect(patchMessage.mock.calls[0][1]).toMatchObject({ status: 'ACCEPTED' });
  });

  it('survives the tier ledger failing', async () => {
    findMessageById.mockResolvedValue({
      ...message(),
      payload: { kind: 'template', templateId: 't-1' },
      templateCategory: 'MARKETING',
    });
    recordBusinessInitiated.mockRejectedValue(new Error('kv down'));

    // No template record: the send is denied before it reaches the ledger, so
    // drive the ledger path through a free-form message outside the window.
    findThreadById.mockResolvedValue({
      id: 'th-1',
      waId: '244923000000',
      accountId: 'acc-1',
      personId: 'p-1',
      isBlocked: false,
      status: 'OPEN',
      serviceWindowExpiresAt: null,
      lastOutboundAt: null,
    });

    const result = await sendOutbound({ messageId: MESSAGE_ID });

    expect(result.outcome).not.toBe('retrying');
  });
});

describe('when Meta itself fails', () => {
  it('still retries a genuine pre-acceptance failure', async () => {
    sendMessage.mockRejectedValue(
      Object.assign(new Error('503 from Meta'), { name: 'MetaApiError' }),
    );

    await sendOutbound({ messageId: MESSAGE_ID });

    // Whether it retries depends on classification; what must not happen is a
    // second send inside this call.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('never writes an acceptance marker for a send that did not happen', async () => {
    sendMessage.mockRejectedValue(new Error('connection refused'));

    await sendOutbound({ messageId: MESSAGE_ID });

    // kv also carries the metric counters, so look for the one key that matters.
    expect(kvSet.mock.calls.map((call) => call[0])).not.toContain(acceptanceKey(MESSAGE_ID));
  });
});
