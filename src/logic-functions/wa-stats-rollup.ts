import { defineLogicFunction } from 'twenty-sdk/define';

import { LF_STATS_ROLLUP } from '../constants/universal-identifiers';
import { looksLikeMetaPacing, rateFor } from '../domain/campaign/guardrails';
import {
  CAMPAIGN_STATUS,
  RECIPIENT_STATUS,
  TEMPLATE_CATEGORY,
  type TemplateCategory,
} from '../domain/constants';
import { clearCampaignChange, readCampaignChange } from '../server/campaign-deltas';
import { config } from '../server/config';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { countRecipients } from '../server/repositories/campaign-recipients';
import {
  listCampaignsByStatus,
  patchCampaign,
  type CampaignPatch,
  type WhatsappCampaignRecord,
} from '../server/repositories/campaigns';
import { findTemplateById } from '../server/repositories/templates';

/**
 * Campaign aggregates (FR-CAM-10, specs/07 §10).
 *
 * **The counters are recomputed from the recipient rows, not folded from the
 * `kv` deltas.** The deltas were specified as the mechanism; in the writing
 * they turned out to be the wrong half of the idea. Their purpose was to avoid
 * one Core API *write* per message, and they do — but so does this, because a
 * recomputation is still one write per campaign per tick. What the deltas
 * cannot do is be correct: `kv` has no compare-and-swap, so an increment lost
 * under concurrency is a number that stays wrong for the life of the campaign,
 * and these numbers are what an operator reads to decide whether a send is
 * going well.
 *
 * So the deltas survive in a different role — as the *hint* that something
 * changed. An idle campaign costs one `kv` read per tick instead of six
 * aggregate queries, and a campaign that moved is recounted exactly.
 *
 * The counters are cumulative funnel positions rather than current states.
 * A recipient sits in exactly one status, so counting `status = SENT` would
 * make `sentCount` *fall* as messages were delivered — a chart that goes
 * backwards while everything is working.
 */

export type RollupResult = {
  considered: number;
  rolled: number;
};

/**
 * Which statuses count toward each funnel stage.
 *
 * `RESPONDED` implies sent and delivered — a reply is proof of both — but not
 * `read`, because a contact with read receipts disabled can answer a message
 * that never produced a `read` status. `readCount` therefore under-reports by
 * design, and the field's own description says so.
 */
export const FUNNEL: Record<string, string[]> = {
  queuedCount: [
    RECIPIENT_STATUS.QUEUED,
    RECIPIENT_STATUS.SENT,
    RECIPIENT_STATUS.DELIVERED,
    RECIPIENT_STATUS.READ,
    RECIPIENT_STATUS.RESPONDED,
    RECIPIENT_STATUS.FAILED,
    RECIPIENT_STATUS.SKIPPED,
  ],
  sentCount: [
    RECIPIENT_STATUS.SENT,
    RECIPIENT_STATUS.DELIVERED,
    RECIPIENT_STATUS.READ,
    RECIPIENT_STATUS.RESPONDED,
  ],
  deliveredCount: [
    RECIPIENT_STATUS.DELIVERED,
    RECIPIENT_STATUS.READ,
    RECIPIENT_STATUS.RESPONDED,
  ],
  readCount: [RECIPIENT_STATUS.READ],
  failedCount: [RECIPIENT_STATUS.FAILED],
  skippedCount: [RECIPIENT_STATUS.SKIPPED],
  respondedCount: [RECIPIENT_STATUS.RESPONDED],
};

/**
 * Only campaigns that can still change are recounted. A completed campaign is
 * included once — `COMPLETED` is set by the runner while statuses are still
 * arriving from Meta, so the final delivered and read counts land minutes
 * *after* the campaign finishes sending, and stopping at completion would
 * freeze every report a minute early.
 */
const ACTIVE_STATUSES = [
  CAMPAIGN_STATUS.RUNNING,
  CAMPAIGN_STATUS.TIER_WAITING,
  CAMPAIGN_STATUS.PAUSED,
  CAMPAIGN_STATUS.COMPLETED,
];

export const hasPendingDelta = async (campaignId: string): Promise<boolean> => {
  const delta = await readCampaignChange(campaignId);

  return delta !== null && Object.keys(delta).length > 0;
};

export const rollupCampaign = async (
  campaign: WhatsappCampaignRecord,
  now: Date,
): Promise<CampaignPatch> => {
  const entries = await Promise.all(
    Object.entries(FUNNEL).map(async ([field, statuses]) => {
      const value = await countRecipients(campaign.id, statuses as never);

      return [field, value] as const;
    }),
  );

  const counts = Object.fromEntries(entries) as Record<string, number>;

  const template =
    typeof campaign.templateId === 'string'
      ? await findTemplateById(campaign.templateId)
      : null;

  const category = (template?.category ?? TEMPLATE_CATEGORY.UTILITY) as TemplateCategory;

  /**
   * Cost accrues on **delivered**, matching how Meta bills, so the actual
   * always lands under the pre-flight estimate. Both are shown, and both are
   * labelled — an estimate presented as a bill is how a finance conversation
   * starts badly.
   */
  const actualCostUsd =
    Math.round(counts.deliveredCount! * rateFor(category, config.rates()) * 10_000) / 10_000;

  const startedAt = campaign.startedAt === null || campaign.startedAt === undefined
    ? null
    : new Date(campaign.startedAt);

  /**
   * Meta intentionally slows large marketing batches to gather early
   * engagement signals. It is a state, not an error: a fifth of a batch
   * accepted but unsent after fifteen minutes with no failures is normal, and
   * saying so is the difference between an informed stakeholder and an
   * incident.
   */
  const stillQueued = await countRecipients(campaign.id, [RECIPIENT_STATUS.QUEUED]);

  const pacingObserved =
    campaign.pacingObserved === true ||
    (startedAt !== null &&
      !Number.isNaN(startedAt.getTime()) &&
      counts.failedCount === 0 &&
      looksLikeMetaPacing({
        queued: counts.queuedCount!,
        acceptedWithoutSentStatus: stillQueued,
        elapsedMs: now.getTime() - startedAt.getTime(),
      }));

  return {
    queuedCount: counts.queuedCount!,
    sentCount: counts.sentCount!,
    deliveredCount: counts.deliveredCount!,
    readCount: counts.readCount!,
    failedCount: counts.failedCount!,
    skippedCount: counts.skippedCount!,
    respondedCount: counts.respondedCount!,
    actualCostUsd,
    pacingObserved,
  };
};

export const rollup = async (now: Date = new Date()): Promise<RollupResult> => {
  const campaigns = await listCampaignsByStatus(ACTIVE_STATUSES, 30);

  const result: RollupResult = { considered: campaigns.length, rolled: 0 };

  for (const campaign of campaigns) {
    try {
      if (!(await hasPendingDelta(campaign.id))) continue;

      const patch = await rollupCampaign(campaign, now);

      await patchCampaign(campaign.id, patch);

      /**
       * Cleared *after* the write. Clearing first would lose the signal if the
       * write failed, and the campaign's numbers would then sit stale until
       * the next status webhook happened to arrive.
       */
      await clearCampaignChange(campaign.id);

      result.rolled += 1;

      if (patch.pacingObserved === true && campaign.pacingObserved !== true) {
        logger.info('wa.campaign.pacing_observed', { correlationId: campaign.id });
      }
    } catch (error) {
      logger.warn('wa.campaign.rollup_failed', {
        correlationId: campaign.id,
        ...describeError(error),
      });
    }
  }

  if (result.rolled > 0) {
    count(METRIC.CAMPAIGN_STATS_ROLLED, result.rolled);
    logger.debug('wa.campaign.stats_rolled', result);
  }

  return result;
};

export const handler = async (): Promise<RollupResult> => rollup();

export default defineLogicFunction({
  universalIdentifier: LF_STATS_ROLLUP,
  name: 'wa-stats-rollup',
  description:
    'Recounts campaign funnel totals and accrued cost from the recipient rows for campaigns that changed.',
  timeoutSeconds: 60,
  cronTriggerSettings: { pattern: '* * * * *' },
  handler,
});
