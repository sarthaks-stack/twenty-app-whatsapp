import { defineLogicFunction } from 'twenty-sdk/define';

import {
  LF_TEMPLATE_EVENT,
  LF_TEMPLATE_SYNC,
} from '../constants/universal-identifiers';
import {
  QUALITY,
  TEMPLATE_STATUS,
  type Quality,
  type TemplateCategory,
  type TemplateStatus,
} from '../domain/constants';
import { assessSupport, deriveVariableSpec } from '../domain/template-spec';
import type { MetaChangeValue } from '../domain/webhook/types';
import { enqueue } from '../server/jobs';
import { logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { asJson } from '../server/repositories/base';
import {
  findTemplateByMetaId,
  patchTemplate,
  type TemplateSyncPatch,
} from '../server/repositories/templates';
import { markWebhookEvent, markWebhookEventFailed } from '../server/repositories/webhook-events';

/**
 * Template lifecycle events from Meta (AR-10, FR-TPL-1).
 *
 * The governing behaviour is **fail closed**. FR-TPL-2 gates reps on
 * `publishedToCrm`, so revoking it is the fastest containment for a template
 * Meta has turned against — and re-publishing is always a deliberate human act.
 * A template that stayed published after a rejection would fail at Meta for
 * every recipient of the next campaign.
 */

export type TemplateEventPayload = {
  webhookEventId?: string;
  accountId: string;
  field: string;
  value: MetaChangeValue;
};

export type TemplateEventResult = {
  outcome: 'patched' | 'unknown_template' | 'ignored';
  templateId?: string;
  unpublished?: boolean;
};

const STATUS_FROM_EVENT: Record<string, TemplateStatus> = {
  APPROVED: TEMPLATE_STATUS.APPROVED,
  REJECTED: TEMPLATE_STATUS.REJECTED,
  PAUSED: TEMPLATE_STATUS.PAUSED,
  DISABLED: TEMPLATE_STATUS.DISABLED,
  PENDING: TEMPLATE_STATUS.PENDING,
  PENDING_DELETION: TEMPLATE_STATUS.DISABLED,
  IN_APPEAL: TEMPLATE_STATUS.IN_APPEAL,
  APPEAL_REQUESTED: TEMPLATE_STATUS.IN_APPEAL,
  FLAGGED: TEMPLATE_STATUS.PAUSED,
};

const QUALITY_FROM_SCORE: Record<string, Quality> = {
  GREEN: QUALITY.GREEN,
  YELLOW: QUALITY.YELLOW,
  RED: QUALITY.RED,
  UNKNOWN: QUALITY.UNKNOWN,
};

/** Statuses in which a template must not be selectable by a rep or a campaign. */
const DEGRADED_STATUSES = new Set<TemplateStatus>([
  TEMPLATE_STATUS.REJECTED,
  TEMPLATE_STATUS.DISABLED,
  TEMPLATE_STATUS.PAUSED,
]);

/**
 * Meta's `components_update` sends the *changed parts*, not the whole component
 * array, under its own field names. Reconstructing an array from them lets the
 * variable spec be re-derived without a full sync round-trip.
 */
export const componentsFromUpdate = (value: MetaChangeValue): unknown[] | null => {
  const parts: Record<string, unknown>[] = [];

  if (typeof value.message_template_title === 'string') {
    parts.push({ type: 'HEADER', format: 'TEXT', text: value.message_template_title });
  }
  if (typeof value.message_template_element === 'string') {
    parts.push({ type: 'BODY', text: value.message_template_element });
  }
  if (typeof value.message_template_footer === 'string') {
    parts.push({ type: 'FOOTER', text: value.message_template_footer });
  }
  if (Array.isArray(value.message_template_buttons)) {
    parts.push({
      type: 'BUTTONS',
      buttons: value.message_template_buttons.map((button) => {
        const raw = button as Record<string, unknown>;

        return {
          type: raw.message_template_button_type,
          text: raw.message_template_button_text,
          url: raw.message_template_button_url,
          phone_number: raw.message_template_button_phone_number,
        };
      }),
    });
  }

  return parts.length === 0 ? null : parts;
};

/**
 * Folds the changed components into the ones already stored.
 *
 * `components_update` is a **partial** payload: an edit to the body arrives as
 * `message_template_element` alone. Replacing the stored array with it dropped
 * the template's header, footer and buttons locally — after which the derived
 * spec said the template had no header, `assessSupport` called it usable, and
 * the next send built a payload missing those parameters, which Meta answers
 * with 132000 for every recipient. The same phantom change also tripped the
 * "variable count changed" rule and unpublished a template nobody had touched
 * that way (D-47).
 *
 * Order follows the stored array, so a component keeps its position; a type
 * that was not there before is appended.
 */
export const mergeComponents = (
  existing: unknown[] | null | undefined,
  incoming: unknown[],
): unknown[] => {
  const typeOf = (component: unknown): string =>
    String((component as { type?: unknown } | null)?.type ?? '').toUpperCase();

  const changed = new Map(incoming.map((component) => [typeOf(component), component]));
  const merged: unknown[] = [];

  for (const component of Array.isArray(existing) ? existing : []) {
    const type = typeOf(component);

    merged.push(changed.get(type) ?? component);
    changed.delete(type);
  }

  return [...merged, ...changed.values()];
};

export const processTemplateEvent = async (
  payload: TemplateEventPayload,
): Promise<TemplateEventResult> => {
  const value = payload.value;
  const metaTemplateId =
    value.message_template_id === undefined ? null : String(value.message_template_id);

  const log = logger.child({
    fn: 'wa-template-event',
    accountId: payload.accountId,
    correlationId: metaTemplateId,
  });

  count(METRIC.TEMPLATE_EVENT);

  if (metaTemplateId === null) {
    log.warn('wa.template.no_id', { field: payload.field });

    return { outcome: 'ignored' };
  }

  const template = await findTemplateByMetaId(payload.accountId, metaTemplateId);

  /**
   * An unknown template means our copy is stale — Meta created or renamed one
   * we have never synced. A full sync is enqueued rather than a record being
   * invented here: sync is authoritative, and a half-built record would be
   * indistinguishable from a real one.
   */
  if (template === null) {
    log.info('wa.template.unknown', { field: payload.field, metaTemplateId });

    await enqueue({
      logicFunctionUniversalIdentifier: LF_TEMPLATE_SYNC,
      payload: { accountId: payload.accountId, reason: 'unknown template on webhook' },
      correlationId: metaTemplateId,
    });

    if (payload.webhookEventId !== undefined) {
      await markWebhookEvent(payload.webhookEventId, 'PROCESSED', 'template not synced');
    }

    return { outcome: 'unknown_template' };
  }

  const patch: TemplateSyncPatch = { lastSyncedAt: new Date().toISOString() };
  let unpublished = false;

  if (payload.field === 'message_template_status_update') {
    const status = STATUS_FROM_EVENT[(value.event ?? '').toUpperCase()];

    if (status !== undefined) {
      patch.status = status;

      if (DEGRADED_STATUSES.has(status) && template.publishedToCrm === true) {
        patch.publishedToCrm = false;
        unpublished = true;
      }
    }

    if (typeof value.reason === 'string') patch.rejectedReason = value.reason;

    /**
     * Meta re-categorises templates silently, and the category drives billing
     * (FR-TPL-5) and campaign eligibility. Recording the previous value is what
     * lets an admin see that a utility template became marketing overnight and
     * quintupled the cost of their campaign.
     */
    const category = (value.message_template_category ?? '').toUpperCase();

    if (
      (category === 'MARKETING' || category === 'UTILITY' || category === 'AUTHENTICATION') &&
      category !== template.category
    ) {
      patch.category = category as TemplateCategory;
      patch.previousCategory = (template.category ?? null) as TemplateCategory | null;
    }
  }

  if (payload.field === 'message_template_quality_update') {
    const quality = QUALITY_FROM_SCORE[(value.new_quality_score ?? '').toUpperCase()];

    if (quality !== undefined) {
      patch.qualityScore = quality;

      // RED is Meta telling us recipients are blocking or reporting this
      // content. Continuing to send it is how a number gets suspended (R-5).
      if (quality === QUALITY.RED && template.publishedToCrm === true) {
        patch.publishedToCrm = false;
        unpublished = true;
      }
    }
  }

  if (payload.field === 'message_template_components_update') {
    const changed = componentsFromUpdate(value);

    if (changed !== null) {
      const stored = asJson<{ components?: unknown[] }>(template.components, {}).components;
      const components = mergeComponents(stored, changed);

      const spec = deriveVariableSpec(components as Parameters<typeof deriveVariableSpec>[0]);
      const support = assessSupport(components as Parameters<typeof assessSupport>[0]);

      patch.components = { components };
      patch.variableSpec = spec as unknown as Record<string, unknown>;
      patch.isUsableInCrm = support.isUsableInCrm;
      patch.unsupportedReason = support.unsupportedReason;

      /**
       * A changed placeholder count invalidates every existing variable
       * mapping. Leaving it published would produce 132000/132012 for every
       * recipient of the next campaign — a failure that looks like a Meta
       * outage and is actually a stale local spec.
       */
      const previousSpec = asJson<{ totalVariableCount?: number }>(template.variableSpec, {});

      if (
        typeof previousSpec.totalVariableCount === 'number' &&
        previousSpec.totalVariableCount !== spec.totalVariableCount &&
        template.publishedToCrm === true
      ) {
        patch.publishedToCrm = false;
        unpublished = true;
        log.warn('wa.template.variable_count_changed', {
          from: previousSpec.totalVariableCount,
          to: spec.totalVariableCount,
        });
      }
    }
  }

  await patchTemplate(template.id, patch);

  if (unpublished) {
    count(METRIC.TEMPLATE_UNPUBLISHED_ON_DEGRADATION);
    log.warn('wa.template.unpublished_on_degradation', {
      templateId: template.id,
      field: payload.field,
    });
  }

  log.info('wa.template.event', { templateId: template.id, field: payload.field, unpublished });

  if (payload.webhookEventId !== undefined) {
    await markWebhookEvent(payload.webhookEventId, 'PROCESSED');
  }

  return { outcome: 'patched', templateId: template.id, unpublished };
};

export const handler = async (
  payload: TemplateEventPayload,
): Promise<TemplateEventResult> => {
  try {
    return await processTemplateEvent(payload);
  } catch (error) {
    if (payload.webhookEventId !== undefined) {
      await markWebhookEventFailed(
        payload.webhookEventId,
        0,
        error instanceof Error ? error.message : String(error),
      );
    }

    throw error;
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_TEMPLATE_EVENT,
  name: 'wa-template-event',
  description:
    "Applies Meta's template status, quality and component updates, un-publishing on degradation.",
  timeoutSeconds: 15,
  handler,
});
