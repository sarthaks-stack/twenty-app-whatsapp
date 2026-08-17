import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_STATUS,
  CONSENT_STATUS,
  LANE,
  QUALITY,
  SOURCE_KIND,
  TEMPLATE_CATEGORY,
  TEMPLATE_STATUS,
} from '../domain/constants';

/**
 * The workflow action (FR-WF-1, FR-CON-4, specs/09 §1).
 *
 * Two claims are worth a test each, and they are the two that make this
 * function different from the composer route it otherwise mirrors.
 *
 * **A denial is data.** An automation that emails a customer when an order ships
 * must not die because one recipient opted out last week — it must be able to
 * branch. So every refusal is a returned `status: 'denied'` with a machine
 * reason, and only infrastructure failures throw.
 *
 * **It reuses the gate.** Consent, window, template state and quality are not
 * re-implemented here; the same pure `evaluateSendPermission` decides. That is
 * why these tests assert on *reasons* the gate produces rather than on rules
 * this file restates.
 */

const findPersonById = vi.fn();
const findAccountById = vi.fn();
const findAccountByPhoneNumberId = vi.fn();
const listAccounts = vi.fn();
const findTemplateById = vi.fn();
const listTemplatesForAccount = vi.fn();
const findThread = vi.fn();
const upsertThread = vi.fn();
const queueOutbound = vi.fn();

vi.mock('../server/repositories/people', () => ({
  findPersonById: (...args: unknown[]) => findPersonById(...args),
}));

vi.mock('../server/repositories/accounts', () => ({
  findAccountById: (...args: unknown[]) => findAccountById(...args),
  findAccountByPhoneNumberId: (...args: unknown[]) => findAccountByPhoneNumberId(...args),
  listAccounts: (...args: unknown[]) => listAccounts(...args),
}));

vi.mock('../server/repositories/templates', () => ({
  findTemplateById: (...args: unknown[]) => findTemplateById(...args),
  listTemplatesForAccount: (...args: unknown[]) => listTemplatesForAccount(...args),
}));

vi.mock('../server/repositories/threads', () => ({
  findThread: (...args: unknown[]) => findThread(...args),
}));

vi.mock('../server/threads', () => ({
  upsertThread: (...args: unknown[]) => upsertThread(...args),
}));

vi.mock('../server/outbound', () => ({
  queueOutbound: (...args: unknown[]) => queueOutbound(...args),
}));

const { ACTION_REFUSAL, asBoolean, personIdOf, runAction, waIdForPerson } = await import(
  './wa-send-template-action'
);

const ACCOUNT_ID = '3f6b0c1e-9a24-4d7b-8c15-2e7f5a3b9d40';
const TEMPLATE_ID = '7c2e8d51-4b93-4a06-9f28-1d6a0e5c3b74';

const ACCOUNT = {
  id: ACCOUNT_ID,
  phoneNumberId: '123',
  status: ACCOUNT_STATUS.CONNECTED,
  qualityRating: QUALITY.GREEN,
  defaultCountryCallingCode: '+244',
};

const PERSON = {
  id: 'p1',
  whatsappOptInStatus: CONSENT_STATUS.OPTED_IN,
  phones: { primaryPhoneNumber: '923000111', primaryPhoneCallingCode: '+244' },
};

const TEMPLATE = {
  id: TEMPLATE_ID,
  name: 'encomenda_pronta',
  language: 'pt_PT',
  category: TEMPLATE_CATEGORY.UTILITY,
  status: TEMPLATE_STATUS.APPROVED,
  publishedToCrm: true,
  isUsableInCrm: true,
  variableSpec: {
    namedParameters: false,
    header: null,
    body: {
      variableCount: 1,
      indices: [1],
      names: [],
      text: 'Olá {{1}}, está pronta.',
      example: [],
    },
    footer: null,
    buttons: [],
  },
};

const THREAD = { id: 'th1', serviceWindowExpiresAt: null, isBlocked: false, personId: 'p1' };

beforeEach(() => {
  for (const mock of [
    findPersonById,
    findAccountById,
    findAccountByPhoneNumberId,
    listAccounts,
    findTemplateById,
    listTemplatesForAccount,
    findThread,
    upsertThread,
    queueOutbound,
  ]) {
    mock.mockReset();
  }

  findPersonById.mockResolvedValue(PERSON);
  findAccountById.mockResolvedValue(ACCOUNT);
  findAccountByPhoneNumberId.mockResolvedValue(null);
  listAccounts.mockResolvedValue([ACCOUNT]);
  findTemplateById.mockResolvedValue(TEMPLATE);
  listTemplatesForAccount.mockResolvedValue([TEMPLATE]);
  findThread.mockResolvedValue(THREAD);
  upsertThread.mockResolvedValue({ thread: THREAD, created: false });
  queueOutbound.mockResolvedValue({ id: 'msg1' });
});

const input = (overrides: Record<string, unknown> = {}) => ({
  personId: 'p1',
  accountId: ACCOUNT_ID,
  templateId: TEMPLATE_ID,
  bodyVariable1: 'Ana',
  ...overrides,
});

describe('reading the step’s inputs', () => {
  it('accepts a person as an id, a record, or the older key', () => {
    expect(personIdOf({ personId: 'p1' })).toBe('p1');
    expect(personIdOf({ personId: { id: 'p1' } })).toBe('p1');
    expect(personIdOf({ person: { id: 'p1' } })).toBe('p1');
    expect(personIdOf({})).toBeNull();
  });

  /**
   * The number and the template are record pickers too, so both hand back the
   * same shapes `Person` does. A picked template arriving as an object and read
   * as a string would be looked up as a template *named* `[object Object]`.
   */
  it('accepts the number and the template as picked records', async () => {
    const result = await runAction({
      personId: { id: 'p1', name: { firstName: 'Ana' } },
      accountId: { id: ACCOUNT_ID, name: 'Pixel' },
      templateId: { id: TEMPLATE_ID, name: 'encomenda_pronta' },
      parameters: '{"1": "Ana"}',
    });

    expect(result.status).toBe('accepted');
    expect(findAccountById).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(findTemplateById).toHaveBeenCalledWith(TEMPLATE_ID);
  });

  /** The builder sends JSON text, with `{{…}}` already interpolated. */
  it('reads the variables as the JSON string the builder sends', async () => {
    await runAction(input({ bodyVariable1: undefined, advancedParameters: '{"1": "Ana"}' }));

    expect(
      (queueOutbound.mock.calls[0]![0] as Record<string, unknown>).body,
    ).toBe('Olá Ana, está pronta.');
  });

  /** The normal path: one labelled box per variable, each independently bindable. */
  it('reads a variable from its own field', async () => {
    await runAction(input({ bodyVariable1: 'Ana' }));

    expect(
      (queueOutbound.mock.calls[0]![0] as Record<string, unknown>).body,
    ).toBe('Olá Ana, está pronta.');
  });

  it('lets the advanced JSON override a field', async () => {
    await runAction(
      input({ bodyVariable1: 'Ana', advancedParameters: '{"1": "Marcos"}' }),
    );

    expect(
      (queueOutbound.mock.calls[0]![0] as Record<string, unknown>).body,
    ).toBe('Olá Marcos, está pronta.');
  });

  /**
   * A step configured before the per-variable fields existed stores its values
   * under `parameters`. Dropping that key would silently blank every variable in
   * every workflow already running.
   */
  it('still honours the original parameters key', async () => {
    await runAction(
      input({ bodyVariable1: undefined, parameters: '{"1": "Marcos"}' }),
    );

    expect(
      (queueOutbound.mock.calls[0]![0] as Record<string, unknown>).body,
    ).toBe('Olá Marcos, está pronta.');
  });

  /**
   * A boolean bound to a workflow variable arrives as a string, and `"false"`
   * is truthy — the exact reading that would create a conversation for a step
   * whose author switched creation off.
   */
  it('reads the string forms of a boolean input', () => {
    expect(asBoolean('false', true)).toBe(false);
    expect(asBoolean('true', false)).toBe(true);
    expect(asBoolean(undefined, true)).toBe(true);
    expect(asBoolean('perhaps', true)).toBe(true);
  });

  it('takes the primary phone, then any additional one', () => {
    expect(waIdForPerson(PERSON as never, '+244')).toBe('244923000111');

    expect(
      waIdForPerson(
        {
          id: 'p2',
          phones: { additionalPhones: [{ number: '923000222', callingCode: '+244' }] },
        } as never,
        '+244',
      ),
    ).toBe('244923000222');
  });
});

describe('a send the policy allows', () => {
  it('queues on the interactive lane, attributed to the workflow', async () => {
    const result = await runAction(input());

    expect(result).toMatchObject({
      status: 'accepted',
      messageId: 'msg1',
      threadId: 'th1',
      denialReason: null,
    });

    expect(queueOutbound).toHaveBeenCalledTimes(1);

    const queued = queueOutbound.mock.calls[0]![0] as Record<string, unknown>;

    expect(queued.lane).toBe(LANE.INTERACTIVE);
    expect(queued.sourceKind).toBe(SOURCE_KIND.WORKFLOW);
    /** No member did this; attributing it to one would be a lie in the transcript. */
    expect(queued.sentById).toBeNull();
    /** The body is the rendered message, not the template name (FR-TPL-5). */
    expect(queued.body).toBe('Olá Ana, está pronta.');
  });

  /**
   * D-22, reached from a second caller. The sender re-reads consent through
   * `thread.personId`; an unlinked thread reads `UNKNOWN`, so an opt-out
   * arriving while the message is queued would not be caught.
   */
  it('links the person the workflow already identified', async () => {
    await runAction(input());

    expect(upsertThread).toHaveBeenCalledWith(
      expect.objectContaining({ personId: 'p1', waId: '244923000111' }),
    );
  });

  it('finds the template by name when the author typed one', async () => {
    findTemplateById.mockResolvedValue(null);

    const result = await runAction(input({ templateId: 'encomenda_pronta' }));

    expect(result.status).toBe('accepted');
  });

  /**
   * `id` is a `UUIDFilter`, and the server validates the shape before looking
   * anything up — so an id lookup on a template *name* raises rather than
   * answering "not found", and the fallback to a name lookup would never run.
   * The guard is what makes a name usable at all, which is the whole point of
   * accepting one.
   */
  it('never sends a name to an id lookup', async () => {
    await runAction(input({ templateId: 'encomenda_pronta', accountId: '123' }));

    expect(findTemplateById).not.toHaveBeenCalled();
    expect(findAccountById).not.toHaveBeenCalled();
    expect(findAccountByPhoneNumberId).toHaveBeenCalledWith('123');
  });

  it('still resolves a number by its phone_number_id', async () => {
    findAccountByPhoneNumberId.mockResolvedValue(ACCOUNT);

    expect((await runAction(input({ accountId: '123' }))).status).toBe('accepted');
  });

  /**
   * The same name in two languages is two different messages. Choosing one
   * would send a customer a message in a language nobody picked.
   */
  it('refuses an ambiguous template name rather than guessing', async () => {
    findTemplateById.mockResolvedValue(null);
    listTemplatesForAccount.mockResolvedValue([
      TEMPLATE,
      { ...TEMPLATE, id: 'other', language: 'en' },
    ]);

    const result = await runAction(input({ templateId: 'encomenda_pronta' }));

    expect(result.denialReason).toBe(ACTION_REFUSAL.TEMPLATE_UNKNOWN);
    expect(queueOutbound).not.toHaveBeenCalled();
  });

  it('uses the only connected number when the step names none', async () => {
    const result = await runAction(input({ accountId: undefined }));

    expect(result.status).toBe('accepted');
    expect(listAccounts).toHaveBeenCalledWith([ACCOUNT_STATUS.CONNECTED]);
  });

  it('refuses to choose between several connected numbers', async () => {
    listAccounts.mockResolvedValue([ACCOUNT, { ...ACCOUNT, id: 'other' }]);

    const result = await runAction(input({ accountId: undefined }));

    expect(result.denialReason).toBe(ACTION_REFUSAL.ACCOUNT_AMBIGUOUS);
  });
});

describe('a refusal is a result, never an exception', () => {
  it('reports an opt-out as denied so the run can branch', async () => {
    findPersonById.mockResolvedValue({
      ...PERSON,
      whatsappOptInStatus: CONSENT_STATUS.OPTED_OUT,
    });

    const result = await runAction(input());

    expect(result).toMatchObject({
      status: 'denied',
      denialReason: 'OPTED_OUT',
      messageId: null,
      threadId: 'th1',
    });

    expect(queueOutbound).not.toHaveBeenCalled();
  });

  it('reports an unpublished template as denied', async () => {
    findTemplateById.mockResolvedValue({ ...TEMPLATE, publishedToCrm: false });

    const result = await runAction(input());

    expect(result.denialReason).toBe('TEMPLATE_UNAVAILABLE');
  });

  it('reports a disconnected number as denied', async () => {
    findAccountById.mockResolvedValue({ ...ACCOUNT, status: ACCOUNT_STATUS.ERROR });

    const result = await runAction(input());

    expect(result.denialReason).toBe('ACCOUNT_NOT_CONNECTED');
  });

  /**
   * Named, not counted. `MISSING_VARIABLES` alone sends the author back to
   * re-read every box; `{{1}}` tells them which one they left unbound.
   */
  it('names the variables it could not bind', async () => {
    const result = await runAction(input({ bodyVariable1: undefined }));

    expect(result.denialReason).toBe(ACTION_REFUSAL.MISSING_VARIABLES);
    expect(result.missingVariables).toEqual(['{{1}}']);
    expect(queueOutbound).not.toHaveBeenCalled();
  });

  it('reports a contact with no usable phone', async () => {
    findPersonById.mockResolvedValue({ id: 'p9', phones: null });

    expect((await runAction(input())).denialReason).toBe(ACTION_REFUSAL.NO_PHONE);
  });

  it('reports an unknown person', async () => {
    findPersonById.mockResolvedValue(null);

    expect((await runAction(input())).denialReason).toBe(ACTION_REFUSAL.PERSON_UNKNOWN);
  });

  it('does not open a conversation when the step said not to', async () => {
    findThread.mockResolvedValue(null);

    const result = await runAction(input({ createThreadIfMissing: 'false' }));

    expect(result.denialReason).toBe(ACTION_REFUSAL.NO_THREAD);
    expect(upsertThread).not.toHaveBeenCalled();
  });

  it('opens one by default', async () => {
    findThread.mockResolvedValue(null);

    expect((await runAction(input())).status).toBe('accepted');
    expect(upsertThread).toHaveBeenCalledTimes(1);
  });
});

describe('an infrastructure failure', () => {
  /**
   * The other half of the contract. A Core API outage must reach the platform
   * as a failure so the step is retried; swallowing it into `denied` would make
   * an outage look like a business decision and lose the message silently.
   */
  it('propagates rather than being reported as a denial', async () => {
    queueOutbound.mockRejectedValue(new Error('core api unavailable'));

    await expect(runAction(input())).rejects.toThrow('core api unavailable');
  });
});
