import { defineLogicFunction } from 'twenty-sdk/define';

import {
  LF_SEND_TEMPLATE_ACTION,
  OBJ_ACCOUNT,
  OBJ_TEMPLATE,
  PERSON_OBJECT_UID,
} from '../constants/universal-identifiers';
import {
  ACCOUNT_STATUS,
  CONSENT_STATUS,
  LANE,
  SOURCE_KIND,
  QUALITY,
  type AccountStatus,
  type ConsentStatus,
  type Quality,
  type TemplateCategory,
} from '../domain/constants';
import { toE164, toWaId } from '../domain/phone/normalise';
import {
  DENIAL,
  evaluateSendPermission,
  type Denial,
  type SendContext,
  type Warning,
} from '../domain/policy/send-permission';
import {
  renderTemplateBody,
  validateParameters,
} from '../domain/template-render';
import type { VariableSpec } from '../domain/template-spec';
import {
  BODY_VARIABLE_SLOTS,
  bindWorkflowParameters,
  combineVariableInputs,
} from '../domain/workflow-parameters';
import { AUDIT_ACTION, audit } from '../server/audit';
import { personPhones } from '../server/audience';
import { config, forAccount } from '../server/config';
import { describeError, logger } from '../server/logger';
import { queueOutbound } from '../server/outbound';
import {
  findAccountById,
  findAccountByPhoneNumberId,
  listAccounts,
  type WhatsappAccountRecord,
} from '../server/repositories/accounts';
import { asJson, isUuid, toDate } from '../server/repositories/base';
import { findPersonById, type PersonRecord } from '../server/repositories/people';
import {
  findTemplateById,
  listTemplatesForAccount,
  type WhatsappTemplateRecord,
} from '../server/repositories/templates';
import { findThread } from '../server/repositories/threads';
import { upsertThread } from '../server/threads';
import { EMPTY_VARIABLE_SPEC } from './wa-outbound-sender';

/**
 * "Send WhatsApp template" as a workflow step (FR-WF-1, specs/04 §3, 09 §1).
 *
 * The same three moves as the composer route — resolve the conversation, run the
 * policy gate, queue on the interactive lane — reached from a place with no
 * browser, no session and no rep. Two things follow from that, and both are the
 * point of this function rather than incidental to it.
 *
 * **A denial is a result, not an exception.** The step completes with
 * `status: 'denied'` and a machine reason, so an automation can branch on it —
 * `if denied → create a Task "ligar ao cliente"` — instead of the whole run
 * dying because a contact opted out yesterday. Only infrastructure failures
 * throw, because only those are worth retrying.
 *
 * **It shares the gate rather than re-checking consent itself.** That is what
 * makes FR-CON-4 ("workflows respect consent") true by construction: there is no
 * second implementation of the rules to drift from the first, and the binding
 * re-check still happens in the sender on data read at send time.
 */

/** Every reason the step can refuse, including the ones the gate never sees. */
export const ACTION_REFUSAL = {
  ...DENIAL,
  PERSON_UNKNOWN: 'PERSON_UNKNOWN',
  ACCOUNT_UNKNOWN: 'ACCOUNT_UNKNOWN',
  ACCOUNT_AMBIGUOUS: 'ACCOUNT_AMBIGUOUS',
  TEMPLATE_UNKNOWN: 'TEMPLATE_UNKNOWN',
  NO_PHONE: 'NO_PHONE',
  MISSING_VARIABLES: 'MISSING_VARIABLES',
  /** `createThreadIfMissing: false` and there was no conversation. */
  NO_THREAD: 'NO_THREAD',
} as const;
export type ActionRefusal = (typeof ACTION_REFUSAL)[keyof typeof ACTION_REFUSAL] | Denial;

/**
 * Every input is `unknown` on purpose.
 *
 * Three of them are declared as `record`, so each arrives as the record *or* its
 * id depending on how the step was wired, and the two remaining ones arrive as
 * strings whenever they are bound to a workflow variable — including the
 * boolean. Typing them as what they are *declared* as would be typing them as
 * what they are not.
 */
export type SendTemplateActionInput = {
  personId?: unknown;
  /** The same value under the name an older step or a hand-built call may use. */
  person?: unknown;
  accountId?: unknown;
  templateId?: unknown;
  advancedParameters?: unknown;
  /** What the field was called before it became the advanced escape hatch. */
  parameters?: unknown;
  createThreadIfMissing?: unknown;
} & { [K in `bodyVariable${1 | 2 | 3 | 4 | 5}`]?: unknown };

export type SendTemplateActionResult = {
  status: 'accepted' | 'denied';
  messageId: string | null;
  threadId: string | null;
  denialReason: ActionRefusal | null;
  /** Named missing variables, when that is the refusal. */
  missingVariables?: string[];
  warnings: Warning[];
};

/**
 * A `record` input can arrive as the record or as its id, and which one depends
 * on how the step was wired: a workflow variable bound to
 * `{{trigger.record}}` resolves to an object, a hand-typed value to a string,
 * and a record picker to either. Reading all of them is six lines; reading one
 * is a step that fails for most of the ways an author can build it, with
 * `PERSON_UNKNOWN` as the only clue.
 *
 * Used for all three record inputs, not just `Person`. The account and template
 * pickers hand back the same shapes, and a picked template arriving as an object
 * would otherwise be read as a template *named* `[object Object]`.
 */
const idOf = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();

    return trimmed.length === 0 ? null : trimmed;
  }

  if (value !== null && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;

    if (typeof id === 'string' && id.trim().length > 0) return id.trim();
  }

  return null;
};

export const personIdOf = (input: SendTemplateActionInput): string | null =>
  idOf(input.personId) ?? idOf(input.person);

/**
 * Workflow inputs are strings far more often than their declared type suggests
 * — a boolean bound to a variable arrives as `"false"`, which is truthy.
 * Defaults to true, as the spec's default does.
 */
export const asBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
    if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  }

  return fallback;
};

const refuse = (
  reason: ActionRefusal,
  extra: Partial<SendTemplateActionResult> = {},
): SendTemplateActionResult => ({
  status: 'denied',
  messageId: null,
  threadId: null,
  denialReason: reason,
  warnings: [],
  ...extra,
});

/**
 * The sending number.
 *
 * An accountId may be the record id or the `phone_number_id` — the latter is
 * what an operator has in front of them in the Meta dashboard, and refusing it
 * would be pedantry. With nothing named and exactly one number connected, that
 * number is used; with several it is a real decision, because the number a
 * message comes from is what the customer replies to, and picking the first row
 * would make that arbitrary and invisible.
 */
const resolveAccount = async (
  accountId: unknown,
): Promise<
  { ok: true; account: WhatsappAccountRecord } | { ok: false; reason: ActionRefusal }
> => {
  const named = idOf(accountId) ?? '';

  if (named.length > 0) {
    /**
     * The id lookup is attempted only for something id-shaped. `id` is a
     * `UUIDFilter` and the server validates the shape before looking anything
     * up, so `findAccountById('123456789')` raises rather than answering "not
     * found" — and the `??` fallback below would never be reached.
     */
    const account = isUuid(named)
      ? ((await findAccountById(named)) ?? (await findAccountByPhoneNumberId(named)))
      : await findAccountByPhoneNumberId(named);

    return account === null
      ? { ok: false, reason: ACTION_REFUSAL.ACCOUNT_UNKNOWN }
      : { ok: true, account };
  }

  const connected = await listAccounts([ACCOUNT_STATUS.CONNECTED]);

  if (connected.length === 0) return { ok: false, reason: ACTION_REFUSAL.ACCOUNT_UNKNOWN };
  if (connected.length > 1) return { ok: false, reason: ACTION_REFUSAL.ACCOUNT_AMBIGUOUS };

  return { ok: true, account: connected[0]! };
};

/**
 * The template, by id or by name.
 *
 * `templateId` is declared as a string because a select's options must be
 * resolved at design time and the template list is not known then — so an author
 * building a step types something, and what they can see and type is the
 * template's *name*. Accepting only a UUID would make the input unusable from
 * the builder while type-checking perfectly.
 */
const resolveTemplate = async (
  account: WhatsappAccountRecord,
  templateId: string,
): Promise<WhatsappTemplateRecord | null> => {
  const byId = isUuid(templateId) ? await findTemplateById(templateId) : null;

  if (byId !== null) return byId;

  const wanted = templateId.trim().toLowerCase();
  const candidates = (await listTemplatesForAccount(account.id)).filter(
    (template) => (template.name ?? '').toLowerCase() === wanted,
  );

  /**
   * One template, one language: unambiguous. The same name in two languages is
   * two different messages, and choosing one for the author would send a
   * customer a message in a language nobody picked — so it is refused, and the
   * author names the record id instead.
   */
  return candidates.length === 1 ? candidates[0]! : null;
};

/** The person's WhatsApp id, primary phone first, then any additional one. */
export const waIdForPerson = (
  person: PersonRecord,
  defaultCallingCode: string,
): string | null => {
  const phones = personPhones(person);

  for (const candidate of [phones.primary, ...phones.additional]) {
    const e164 = toE164(candidate, defaultCallingCode);

    if (e164 !== null) return toWaId(e164);
  }

  return null;
};

export const runAction = async (
  input: SendTemplateActionInput,
): Promise<SendTemplateActionResult> => {
  const log = logger.child({ fn: 'wa-send-template-action' });

  const personId = personIdOf(input);

  if (personId === null) return refuse(ACTION_REFUSAL.PERSON_UNKNOWN);

  const person = await findPersonById(personId);

  if (person === null) return refuse(ACTION_REFUSAL.PERSON_UNKNOWN);

  const resolved = await resolveAccount(input.accountId);

  if (!resolved.ok) return refuse(resolved.reason);

  const account = resolved.account;

  const templateId = idOf(input.templateId) ?? '';

  if (templateId.length === 0) return refuse(ACTION_REFUSAL.TEMPLATE_UNKNOWN);

  const template = await resolveTemplate(account, templateId);

  if (template === null) return refuse(ACTION_REFUSAL.TEMPLATE_UNKNOWN);

  const defaultCallingCode = forAccount(
    account.defaultCountryCallingCode,
    config.defaultCountryCallingCode,
  );

  const waId = waIdForPerson(person, defaultCallingCode);

  if (waId === null) return refuse(ACTION_REFUSAL.NO_PHONE);

  /**
   * The conversation. `upsertThread` is the only way a thread comes into
   * existence anywhere in the app, which is the mechanical guarantee behind
   * FR-OUT-5 — and specifically the avoidance of the Chatwoot defect where a
   * template send opened a second conversation beside the existing one.
   *
   * `personId` is passed because the workflow already knows who this is. A
   * thread left unlinked would read consent as `UNKNOWN` in the sender's
   * re-check (D-22), which is how an opt-out that arrives while the message is
   * queued gets missed.
   */
  const createIfMissing = asBoolean(input.createThreadIfMissing, true);

  const existing = await findThread(account.id, waId);

  if (existing === null && !createIfMissing) {
    return refuse(ACTION_REFUSAL.NO_THREAD);
  }

  const { thread } = await upsertThread({ account, waId, personId: person.id });

  const variableSpec = asJson<VariableSpec>(template.variableSpec, EMPTY_VARIABLE_SPEC);

  /**
   * The five numbered fields, then the advanced JSON over the top. `parameters`
   * is still read so a step configured before the fields existed keeps working.
   */
  const parameters = bindWorkflowParameters(
    variableSpec,
    combineVariableInputs(
      Array.from(
        { length: BODY_VARIABLE_SLOTS },
        (_unused, index) =>
          (input as Record<string, unknown>)[`bodyVariable${index + 1}`],
      ),
      input.advancedParameters ?? input.parameters,
    ),
  );

  const validation = validateParameters(variableSpec, parameters);

  if (!validation.ok) {
    log.info('wa.workflow.missing_variables', {
      correlationId: thread.id,
      template: template.name,
      missing: validation.missingKeys,
    });

    return refuse(ACTION_REFUSAL.MISSING_VARIABLES, {
      threadId: thread.id,
      missingVariables: validation.missingKeys,
    });
  }

  const context: SendContext = {
    now: new Date(),
    thread: {
      serviceWindowExpiresAt: toDate(thread.serviceWindowExpiresAt),
      isBlocked: thread.isBlocked === true,
    },
    person: {
      whatsappOptInStatus: (person.whatsappOptInStatus ??
        CONSENT_STATUS.UNKNOWN) as ConsentStatus,
    },
    account: {
      status: (account.status ?? ACCOUNT_STATUS.PENDING) as AccountStatus,
      qualityRating: (account.qualityRating ?? QUALITY.UNKNOWN) as Quality,
    },
    template: {
      status: template.status as NonNullable<SendContext['template']>['status'],
      publishedToCrm: template.publishedToCrm === true,
      isUsableInCrm: template.isUsableInCrm === true,
    },
  };

  const verdict = evaluateSendPermission(
    {
      kind: 'TEMPLATE',
      lane: LANE.INTERACTIVE,
      ...(template.category === null || template.category === undefined
        ? {}
        : { templateCategory: template.category as TemplateCategory }),
    },
    context,
  );

  if (!verdict.allowed) {
    log.info('wa.workflow.denied', {
      correlationId: thread.id,
      reason: verdict.reason,
      template: template.name,
    });

    return {
      status: 'denied',
      messageId: null,
      threadId: thread.id,
      denialReason: verdict.reason,
      warnings: verdict.warnings,
    };
  }

  const message = await queueOutbound({
    thread,
    account,
    spec: { kind: 'template', templateId: template.id, contextWamid: null },
    body: renderTemplateBody(variableSpec, parameters),
    lane: LANE.INTERACTIVE,
    /**
     * `WORKFLOW`, not `AGENT`. The transcript shows who sent a message, and
     * attributing an automated send to the last human who touched the record
     * would be a lie a rep then has to answer for.
     */
    sourceKind: SOURCE_KIND.WORKFLOW,
    sentById: null,
    template: {
      id: template.id,
      name: template.name,
      language: template.language,
      category: template.category,
      parameters,
    },
  });

  audit({
    action: AUDIT_ACTION.TEMPLATE_SEND,
    /** No actor: a workflow ran it, and naming a member would misattribute it. */
    actorId: null,
    subject: { threadId: thread.id, personId: person.id, templateId: template.id },
    details: {
      messageId: message.id,
      template: template.name,
      sourceKind: SOURCE_KIND.WORKFLOW,
    },
  });

  return {
    status: 'accepted',
    messageId: message.id,
    threadId: thread.id,
    denialReason: null,
    warnings: verdict.warnings,
  };
};

/**
 * Only infrastructure failures throw.
 *
 * The distinction is the whole contract: a policy refusal is data the workflow
 * branches on, while a Core API outage is something the platform should retry.
 * Collapsing the two would either make every opt-out kill a run or make every
 * outage look like a business decision.
 */
export const handler = async (
  input: SendTemplateActionInput,
): Promise<SendTemplateActionResult> => {
  try {
    return await runAction(input ?? {});
  } catch (error) {
    logger.error('wa.workflow.action_failed', describeError(error));

    throw error;
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_SEND_TEMPLATE_ACTION,
  name: 'wa-send-template-action',
  description:
    'Sends an approved WhatsApp template to a Person from a workflow, applying the same policy gate as a rep’s send.',
  timeoutSeconds: 30,
  /**
   * One entry, and it is an object.
   *
   * `inputSchema` is positional over the *handler's parameters*, not a list of
   * named fields: left undefined, the CLI derives it by parsing the handler's
   * signature and keeps only the first parameter, requiring it to be an object
   * type literal. Writing the five inputs as five array entries — the shape the
   * spec sketched — would declare a five-argument handler and bind none of them
   * to the single object this one receives.
   *
   * **`icon` does not reach the step header.** Twenty renders the
   * *application's* logo there, so the icon an author sees above this step comes
   * from `application-config.ts`'s `logo`. The name is kept because it is
   * correct and costs nothing if a future version does use it.
   *
   * **The property *names* set the field order in the panel**, which is why they
   * look padded. The step's inputs are stored as Postgres `jsonb`, which orders
   * keys by length and then bytewise, and the builder renders them in stored
   * order — so `personId` (8) · `accountId` (9) · `templateId` (10) ·
   * `bodyVariable1…5` (13) · `advancedParameters` (18) ·
   * `createThreadIfMissing` (21) reads top to bottom in the order an author fills
   * it in. Observed rather than assumed: the first build declared `parameters`
   * before `templateId` and the panel showed Variables above Template.
   */
  workflowActionTriggerSettings: {
    label: 'Send WhatsApp template',
    icon: 'IconBrandWhatsapp',
    inputSchema: [
      {
        type: 'object',
        properties: {
          personId: {
            type: 'record',
            label: 'Person',
            objectUniversalIdentifier: PERSON_OBJECT_UID,
          },
          /**
           * Record pickers, not text boxes.
           *
           * These were declared as `string` because the spec said a select whose
           * options are "resolved at design time" — and nothing can be, since
           * the numbers and templates live in the workspace, not in the
           * manifest. But `whatsappAccount` and `whatsappTemplate` are ordinary
           * Twenty objects, so `record` gives the builder the same picker
           * `Person` gets, listing the real rows, for free. Asking an author to
           * paste a WABA id into a text field was the app's mistake, not the
           * platform's limitation.
           */
          accountId: {
            type: 'record',
            label: 'WhatsApp number (optional if only one is connected)',
            objectUniversalIdentifier: OBJ_ACCOUNT,
          },
          templateId: {
            type: 'record',
            label: 'Template (must be approved and published)',
            objectUniversalIdentifier: OBJ_TEMPLATE,
          },
          /**
           * One field per variable, because a JSON box is not an input — it is
           * homework.
           *
           * Twenty cannot load a template's variables on demand: the schema is
           * in the manifest and there is no resolver it calls to recompute one
           * from a half-filled step, so "field by field" has to mean a fixed set
           * of fields. Each is a plain `string`, which is also the only type
           * Twenty gives an `(x)` variable binding to — an `object` input renders
           * as a bare box with none, which had made the field that most needs
           * `{{trigger.record.name.firstName}}` the only one unable to take it.
           *
           * `{{1}}` … `{{5}}` is Meta's own body numbering. For a template using
           * named placeholders these are still positional — first variable in the
           * template, second, and so on — which `bindWorkflowParameters` maps
           * onto the names from the stored spec.
           */
          bodyVariable1: { type: 'string', label: 'Variable {{1}}' },
          bodyVariable2: { type: 'string', label: 'Variable {{2}}' },
          bodyVariable3: { type: 'string', label: 'Variable {{3}}' },
          bodyVariable4: { type: 'string', label: 'Variable {{4}}' },
          bodyVariable5: { type: 'string', label: 'Variable {{5}}' },
          /**
           * The escape hatch: a header image, a button URL, a named variable, a
           * sixth body variable. Merged over the numbered fields, so it overrides
           * rather than competes.
           */
          advancedParameters: {
            type: 'string',
            label: 'Advanced — header, buttons or named variables (JSON)',
            multiline: true,
          },
          createThreadIfMissing: {
            type: 'boolean',
            label: 'Create conversation if missing',
          },
        },
      },
    ],
    outputSchema: [
      {
        type: 'object',
        properties: {
          status: { type: 'string', label: 'status' },
          messageId: { type: 'string', label: 'messageId' },
          threadId: { type: 'string', label: 'threadId' },
          denialReason: { type: 'string', label: 'denialReason' },
          missingVariables: { type: 'array', label: 'missingVariables' },
          warnings: { type: 'array', label: 'warnings' },
        },
      },
    ],
  },
  handler,
});
