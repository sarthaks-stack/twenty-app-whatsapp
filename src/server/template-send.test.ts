import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findAccountById: vi.fn(),
  findAccountByPhoneNumberId: vi.fn(),
  listAccounts: vi.fn(),
  findMessageByClientToken: vi.fn(),
  findPersonById: vi.fn(),
  findTemplateById: vi.fn(),
  listTemplatesForAccount: vi.fn(),
  findThread: vi.fn(),
  upsertThread: vi.fn(),
  queueOutbound: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('./repositories/accounts', () => ({
  findAccountById: mocks.findAccountById,
  findAccountByPhoneNumberId: mocks.findAccountByPhoneNumberId,
  listAccounts: mocks.listAccounts,
}));
vi.mock('./repositories/messages', () => ({
  findMessageByClientToken: mocks.findMessageByClientToken,
}));
vi.mock('./repositories/people', () => ({ findPersonById: mocks.findPersonById }));
vi.mock('./repositories/templates', () => ({
  findTemplateById: mocks.findTemplateById,
  listTemplatesForAccount: mocks.listTemplatesForAccount,
}));
vi.mock('./repositories/threads', () => ({ findThread: mocks.findThread }));
vi.mock('./threads', () => ({ upsertThread: mocks.upsertThread }));
vi.mock('./outbound', () => ({ queueOutbound: mocks.queueOutbound }));
vi.mock('./audit', () => ({
  AUDIT_ACTION: { TEMPLATE_SEND: 'template.send' },
  audit: mocks.audit,
}));

import {
  ACTION_REFUSAL,
  executeTemplateSend,
  sameTemplateSendIntent,
} from './template-send';

const PERSON_ID = '2a296bab-0ed4-4a4d-8293-513d624e6971';
const TEMPLATE_ID = 'a03833c2-2a76-42c7-829f-d78f61360e0f';
const ACCOUNT_ID = '56136228-bba6-48c4-b738-7b84edebe447';
const REQUEST_ID = 'fb044e6d-5195-4c71-98c0-d5f60ad18cf4';

const parameters = {
  body: ['Ana'],
  buttons: [{ index: 0, subType: 'URL', value: 'tracking-1' }],
};
const intent = {
  threadId: 'thread-1',
  templateId: TEMPLATE_ID,
  sourceKind: 'AI_AGENT' as const,
  parameters,
};
const existingMessage = {
  id: 'message-1',
  threadId: 'thread-1',
  templateId: TEMPLATE_ID,
  sourceKind: 'AI_AGENT',
  templateParameters: {
    buttons: [{ value: 'tracking-1', subType: 'URL', index: 0 }],
    body: ['Ana'],
  },
};

const source = {
  sourceKind: 'AI_AGENT' as const,
  sentById: null,
  requestId: REQUEST_ID,
  channel: 'TWENTY_MCP' as const,
  accountResolution: 'exact' as const,
  templateResolution: 'exact' as const,
};

const sendInput = {
  personId: PERSON_ID,
  accountId: ACCOUNT_ID,
  templateId: TEMPLATE_ID,
  parameters,
};

describe('template-send idempotency intent comparison', () => {
  it('treats reordered JSON keys as the same send intent', () => {
    expect(sameTemplateSendIntent(existingMessage, intent)).toBe(true);
  });

  it.each([
    ['another thread', { threadId: 'thread-2' }],
    ['another template', { templateId: 'template-2' }],
    ['another source', { sourceKind: 'WORKFLOW' }],
    [
      'other parameters',
      { templateParameters: { body: ['Maria'], buttons: parameters.buttons } },
    ],
  ])('rejects a request id reused for %s', (_label, change) => {
    expect(sameTemplateSendIntent({ ...existingMessage, ...change }, intent)).toBe(false);
  });
});

describe('executeTemplateSend idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findPersonById.mockResolvedValue({
      id: PERSON_ID,
      phones: {
        primaryPhoneNumber: '923000111',
        primaryPhoneCallingCode: '+244',
        additionalPhones: [],
      },
      whatsappOptInStatus: 'OPTED_IN',
    });
    mocks.findAccountById.mockResolvedValue({
      id: ACCOUNT_ID,
      status: 'CONNECTED',
      qualityRating: 'GREEN',
      defaultCountryCallingCode: '+244',
    });
    mocks.findTemplateById.mockResolvedValue({
      id: TEMPLATE_ID,
      accountId: ACCOUNT_ID,
      name: 'order_ready',
      language: 'pt_PT',
      category: 'UTILITY',
      status: 'APPROVED',
      publishedToCrm: true,
      isUsableInCrm: true,
      variableSpec: {
        namedParameters: false,
        header: null,
        body: {
          variableCount: 1,
          indices: [1],
          names: [],
          text: 'Olá {{1}}',
          example: ['Ana'],
        },
        footer: null,
        buttons: [
          {
            index: 0,
            type: 'URL',
            hasVariable: true,
            text: 'Acompanhar',
            url: 'https://example.test/{{1}}',
          },
        ],
        totalVariableCount: 2,
      },
    });
    mocks.findThread.mockResolvedValue({ id: 'thread-1', isBlocked: false });
    mocks.upsertThread.mockResolvedValue({
      thread: { id: 'thread-1', isBlocked: false },
      created: false,
    });
    mocks.queueOutbound.mockResolvedValue({ id: 'message-2' });
    mocks.findMessageByClientToken.mockResolvedValue(null);
  });

  it('returns the original message for a matching retry without queueing or auditing', async () => {
    mocks.findMessageByClientToken.mockResolvedValue(existingMessage);

    const result = await executeTemplateSend(sendInput, source);

    expect(result).toMatchObject({
      status: 'accepted',
      messageId: 'message-1',
      threadId: 'thread-1',
      replayed: true,
    });
    expect(mocks.queueOutbound).not.toHaveBeenCalled();
    expect(mocks.upsertThread).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('refuses a request id reused for different values', async () => {
    mocks.findMessageByClientToken.mockResolvedValue({
      ...existingMessage,
      templateParameters: { ...parameters, body: ['Maria'] },
    });

    const result = await executeTemplateSend(sendInput, source);

    expect(result).toMatchObject({
      status: 'denied',
      denialReason: ACTION_REFUSAL.IDEMPOTENCY_CONFLICT,
      replayed: false,
    });
    expect(mocks.queueOutbound).not.toHaveBeenCalled();
  });

  it('does not create a thread before refusing a reused request id', async () => {
    mocks.findThread.mockResolvedValue(null);
    mocks.findMessageByClientToken.mockResolvedValue(existingMessage);

    const result = await executeTemplateSend(sendInput, source);

    expect(result.denialReason).toBe(ACTION_REFUSAL.IDEMPOTENCY_CONFLICT);
    expect(mocks.upsertThread).not.toHaveBeenCalled();
    expect(mocks.queueOutbound).not.toHaveBeenCalled();
  });

  it('re-reads and returns the winner of a concurrent unique-key race', async () => {
    mocks.findMessageByClientToken
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingMessage);
    mocks.queueOutbound.mockRejectedValue(new Error('duplicate key violates unique constraint'));

    const result = await executeTemplateSend(sendInput, source);

    expect(result).toMatchObject({
      status: 'accepted',
      messageId: 'message-1',
      replayed: true,
    });
    expect(mocks.findMessageByClientToken).toHaveBeenCalledTimes(2);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('queues and audits a new request exactly once without parameter values', async () => {
    const result = await executeTemplateSend(sendInput, source);

    expect(result).toMatchObject({
      status: 'accepted',
      messageId: 'message-2',
      replayed: false,
    });
    expect(mocks.queueOutbound).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]![0].details).toEqual({
      messageId: 'message-2',
      template: 'order_ready',
      sourceKind: 'AI_AGENT',
      channel: 'TWENTY_MCP',
      requestId: REQUEST_ID,
    });
  });
});
