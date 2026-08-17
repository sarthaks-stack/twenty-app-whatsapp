import { defineLogicFunction } from 'twenty-sdk/define';

import {
  LF_SEND_TEMPLATE_ACTION,
  OBJ_ACCOUNT,
  OBJ_TEMPLATE,
  PERSON_OBJECT_UID,
} from '../constants/universal-identifiers';
import { SOURCE_KIND } from '../domain/constants';
import type { Warning } from '../domain/policy/send-permission';
import {
  BODY_VARIABLE_SLOTS,
  combineVariableInputs,
} from '../domain/workflow-parameters';
import { describeError, logger } from '../server/logger';
import {
  ACTION_REFUSAL,
  asBoolean,
  executeTemplateSend,
  personIdOf,
  waIdForPerson,
  type ActionRefusal,
} from '../server/template-send';

export { ACTION_REFUSAL, asBoolean, personIdOf, waIdForPerson };

/**
 * "Send WhatsApp template" as a workflow step (FR-WF-1, specs/04 §3, 09 §1).
 *
 * A denial is a result, not an exception. The step shares the same target
 * resolution, policy gate and queueing service as the MCP tool; its wrapper is
 * responsible only for adapting the workflow builder's input shape and for
 * identifying the send as a workflow send.
 */

/** Record inputs arrive as records or ids; workflow bindings often arrive as strings. */
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
  missingVariables?: string[];
  warnings: Warning[];
};

export const runAction = async (
  input: SendTemplateActionInput,
): Promise<SendTemplateActionResult> => {
  const result = await executeTemplateSend(
    {
      personId: personIdOf(input),
      accountId: input.accountId,
      templateId: input.templateId,
      parameters: combineVariableInputs(
        Array.from(
          { length: BODY_VARIABLE_SLOTS },
          (_unused, index) =>
            (input as Record<string, unknown>)[`bodyVariable${index + 1}`],
        ),
        input.advancedParameters ?? input.parameters,
      ),
      createThreadIfMissing: input.createThreadIfMissing,
    },
    {
      sourceKind: SOURCE_KIND.WORKFLOW,
      sentById: null,
      requestId: null,
      channel: 'WORKFLOW_ACTION',
      accountResolution: 'workflow',
      templateResolution: 'workflow',
    },
  );

  return {
    status: result.status,
    messageId: result.messageId,
    threadId: result.threadId,
    denialReason: result.denialReason,
    ...(result.missingVariables === undefined
      ? {}
      : { missingVariables: result.missingVariables }),
    warnings: result.warnings,
  };
};

/** Only infrastructure failures throw; business and policy refusals are data. */
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
   * One entry, and it is an object. `inputSchema` is positional over the
   * handler's parameters, not a list of named fields.
   *
   * The property names preserve the builder's jsonb display order: person,
   * account, template, five simple body values, advanced JSON, create.
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
          bodyVariable1: { type: 'string', label: 'Variable {{1}}' },
          bodyVariable2: { type: 'string', label: 'Variable {{2}}' },
          bodyVariable3: { type: 'string', label: 'Variable {{3}}' },
          bodyVariable4: { type: 'string', label: 'Variable {{4}}' },
          bodyVariable5: { type: 'string', label: 'Variable {{5}}' },
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
