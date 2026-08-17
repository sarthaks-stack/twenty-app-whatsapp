import { nodesOf, query } from './repositories/base';
import { describeError, logger } from './logger';

/**
 * The default escalation workflow (D-10 layer 3, specs/09 §6).
 *
 * Unread counts and the live toast reach a rep who is looking. Layer 3 is the
 * only one that reaches a rep who is not — and Twenty gives apps no notification
 * API, so it has to be an ordinary workflow the operator owns.
 *
 * That was going to be a paragraph in the runbook. A paragraph in a runbook is
 * not a default: an operator building this by hand has to know that the trigger
 * is `whatsappMessage.created` — a name that appears nowhere in the builder —
 * before they can start. This writes the workflow, the trigger and the Task
 * step in one click, and hands back the two things the operator still has to
 * decide (see `REVIEW_NOTES`).
 *
 * **It creates a draft, and stops.** Activating a workflow that writes a Task
 * for every inbound message is a decision about a team's inbox, not a side
 * effect of pressing a button in a settings panel — and the app cannot activate
 * a version through the API anyway. The operator opens it, reads it, adds the
 * direction filter, changes the action if a Slack post suits them better, and
 * activates it.
 */

export const NOTIFICATION_WORKFLOW_NAME = 'WhatsApp — notify the assignee';

export type ProvisionResult = {
  workflowId: string;
  versionId: string | null;
  /** True when the workflow already existed and nothing was written. */
  existed: boolean;
  name: string;
  /** Machine codes for the steps left to the operator; see `REVIEW_NOTES`. */
  reviewNotes: readonly string[];
};

/**
 * The trigger.
 *
 * `whatsappMessage.created` fires for **both** directions. The direction filter
 * is therefore mandatory before this workflow is activated — without it, every
 * message a rep sends creates a Task telling them to reply to themselves — and
 * it is deliberately *not* written here: the filter shape belongs to Twenty's
 * workflow engine, and a filter this app guessed at and got wrong would look
 * present and match nothing, which is the same failure with none of the
 * visibility. It is named in `REVIEW_NOTES` instead, where the operator reads it
 * on the way to the builder they have to open anyway.
 */
const trigger = () => ({
  name: 'When a WhatsApp message arrives',
  type: 'DATABASE_EVENT',
  settings: {
    eventName: 'whatsappMessage.created',
    outputSchema: {},
  },
});

/**
 * What the operator must do before activating, in the order they will do it.
 *
 * Machine-readable strings rather than prose: the settings panel owns the pt/en
 * copy (specs/01 §7), and these are its keys.
 */
export const REVIEW_NOTES = [
  'FILTER_INBOUND',
  'CHOOSE_ASSIGNEE',
  'ACTIVATE',
] as const;

/**
 * The step, deliberately minimal.
 *
 * A Task with a title and the thread's assignee is the whole of it. Anything
 * richer — the message body in the task, a due date, a second step — is a guess
 * about how a particular team works, and every guess is one more thing the
 * operator has to undo before the workflow is theirs.
 *
 * `valid: false` because the builder has not validated it. Claiming otherwise
 * would be the app asserting something about a document it cannot check.
 */
const steps = (stepId: string) => [
  {
    id: stepId,
    name: 'Create a Task for the assignee',
    type: 'CREATE_RECORD',
    valid: false,
    settings: {
      input: {
        objectName: 'task',
        objectRecord: {
          title: 'Responder no WhatsApp',
          status: 'TODO',
        },
      },
      outputSchema: {},
      errorHandlingOptions: {
        retryOnFailure: { value: false },
        continueOnFailure: { value: false },
      },
    },
    nextStepIds: [],
  },
];

const findExisting = async (): Promise<{ id: string } | null> => {
  const result = await query(
    (client) =>
      client.query({
        workflows: {
          __args: { filter: { name: { eq: NOTIFICATION_WORKFLOW_NAME } }, first: 1 },
          edges: { node: { id: true, name: true } },
        },
      }),
    'workflows.findDefault',
  );

  return nodesOf<{ id: string }>(result.workflows)[0] ?? null;
};

/**
 * A v4 identifier for the step, or nothing.
 *
 * Every identifier this app writes is a v4 UUID, and the workflow engine keys
 * steps by id. Rather than hand-rolling a generator that might produce a
 * non-conforming value, the absence of `crypto.randomUUID` is treated as a
 * reason not to provision — a wrong id would be written once and be wrong for
 * as long as the workflow exists.
 */
const stepId = (): string | null => {
  const source = globalThis.crypto;

  return typeof source?.randomUUID === 'function' ? source.randomUUID() : null;
};

export const provisionNotificationWorkflow = async (): Promise<
  { ok: true; result: ProvisionResult } | { ok: false; error: string }
> => {
  const log = logger.child({ fn: 'notification-workflow' });

  /**
   * Idempotent by name. The button lives in a settings panel that reloads, so
   * pressing it twice must produce one workflow — not two identical ones an
   * operator then has to tell apart.
   */
  const existing = await findExisting();

  if (existing !== null) {
    return {
      ok: true,
      result: {
        workflowId: existing.id,
        versionId: null,
        existed: true,
        name: NOTIFICATION_WORKFLOW_NAME,
        reviewNotes: REVIEW_NOTES,
      },
    };
  }

  const id = stepId();

  if (id === null) {
    return { ok: false, error: 'This runtime cannot generate a step identifier' };
  }

  const created = await query(
    (client) =>
      client.mutation({
        createWorkflow: {
          __args: { data: { name: NOTIFICATION_WORKFLOW_NAME } },
          id: true,
        },
      }),
    'workflows.create',
  );

  const workflowId = created.createWorkflow?.id ?? null;

  if (typeof workflowId !== 'string') {
    return { ok: false, error: 'The workflow could not be created' };
  }

  /**
   * The version is written separately and may fail on its own — the shapes of
   * `trigger` and `steps` belong to Twenty's workflow engine, not to this app.
   * A failure here leaves an empty workflow the operator can still build in,
   * which is a far better outcome than a rolled-back button that reports
   * nothing happened when a record was in fact created.
   */
  try {
    const version = await query(
      (client) =>
        client.mutation({
          createWorkflowVersion: {
            __args: {
              data: {
                workflowId,
                name: 'v1',
                status: 'DRAFT',
                trigger: trigger(),
                /**
                 * `steps` is a JSON scalar that genql types as an object, but
                 * the workflow engine stores an **array** — the same mismatch
                 * `repositories/base.ts` documents for RAW_JSON columns.
                 * Wrapping it in a key to satisfy the type would store a shape
                 * the builder cannot read, so the cast is the correct side of
                 * the trade and is confined to this one line.
                 */
                steps: steps(id) as unknown as Record<string, unknown>,
              },
            },
            id: true,
          },
        }),
      'workflows.createVersion',
    );

    return {
      ok: true,
      result: {
        workflowId,
        versionId: version.createWorkflowVersion?.id ?? null,
        existed: false,
        name: NOTIFICATION_WORKFLOW_NAME,
        reviewNotes: REVIEW_NOTES,
      },
    };
  } catch (error) {
    log.warn('wa.notification_workflow.version_failed', {
      workflowId,
      ...describeError(error),
    });

    return {
      ok: true,
      result: {
        workflowId,
        versionId: null,
        existed: false,
        name: NOTIFICATION_WORKFLOW_NAME,
        reviewNotes: REVIEW_NOTES,
      },
    };
  }
};
