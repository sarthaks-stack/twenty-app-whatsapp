import { defineLogicFunction } from 'twenty-sdk/define';

import { LF_CAMPAIGN_RUNNER } from '../constants/universal-identifiers';
import { isCircuitBroken, type FailureWindow } from '../domain/campaign/guardrails';
import { claimableCount } from '../domain/campaign/tier-budget';
import { STATUS_REASON } from '../domain/campaign/transitions';
import {
  ACCOUNT_STATUS,
  CAMPAIGN_STATUS,
  LANE,
  QUALITY,
  RECIPIENT_STATUS,
  SOURCE_KIND,
  TEMPLATE_STATUS,
  type CampaignStatus,
} from '../domain/constants';
import { toWaId } from '../domain/phone/normalise';
import type { ResolvedParameters } from '../domain/template-render';
import { transitionCampaign } from '../server/campaign-state';
import { config } from '../server/config';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { queueOutbound } from '../server/outbound';
import { findAccountById, type WhatsappAccountRecord } from '../server/repositories/accounts';
import { asJson } from '../server/repositories/base';
import {
  claimPendingRecipients,
  countRecipients,
  findStaleClaimedRecipients,
  listRecentTerminalRecipients,
  patchRecipient,
  patchRecipients,
  type WhatsappCampaignRecipientRecord,
} from '../server/repositories/campaign-recipients';
import {
  findCampaignById,
  listCampaignsByStatus,
  listDueCampaigns,
  type WhatsappCampaignRecord,
} from '../server/repositories/campaigns';
import { findTemplateById, type WhatsappTemplateRecord } from '../server/repositories/templates';
import { scheduleSend } from '../server/schedule';
import { budgetForAccount, isWindowExpired } from '../server/tier-ledger';
import { upsertThread } from '../server/threads';

/**
 * The campaign runner (AR-19, AR-20, FR-CAM-7, specs/07 §6).
 *
 * A chunked, resumable state machine on a one-minute tick. It creates no
 * transport of its own: a campaign message is an ordinary `whatsappMessage` on
 * the campaign lane, sent by the one sender, tracked by the same status
 * webhooks as a rep's reply. That is what AR-19 means, and it is why a campaign
 * reply lands in the inbox with the window open rather than in a parallel
 * universe of bulk-send state.
 *
 * **No recipient is ever sent twice** (AR-20), guaranteed three independent
 * ways so that no single failure can produce a duplicate:
 *
 *  1. *Claim before act.* A recipient moves `PENDING → CLAIMED` in a mutation
 *     whose own filter still requires `PENDING`, and the runner uses the rows
 *     that mutation returned — so a second tick that selected the same ids is
 *     handed nothing.
 *  2. *Unique (campaign, person).* Even a duplicated snapshot cannot produce
 *     two rows for one person.
 *  3. *Unique WAMID.* Even a duplicated send cannot produce two messages.
 *
 * The recoverable gap is a crash between claiming and queueing, which leaves
 * rows `CLAIMED` with no message. The stale-claim sweep at the end of each tick
 * returns those to `PENDING`, which is the "loses at most the in-flight batch"
 * that AR-20 permits.
 */

export type RunnerResult = {
  started: number;
  resumed: number;
  ticked: number;
  queued: number;
  completed: number;
  paused: number;
  staleClaimsReverted: number;
};

/** At most three campaigns a tick, so one large run cannot monopolise the lane. */
export const MAX_CAMPAIGNS_PER_TICK = 3;

/**
 * A campaign ticked within the last 30 seconds is skipped.
 *
 * Two overlapping ticks of one campaign would both claim, and while the claim
 * makes that safe it is not free: the loser spends a whole invocation
 * discovering it has nothing to do. The interval is shorter than the cron
 * period so an ordinary minute never trips it.
 */
export const MIN_TICK_INTERVAL_MS = 30_000;

/** A claim older than this was taken by a tick that died (specs/07 §6.1). */
export const STALE_CLAIM_MS = 10 * 60_000;

const TERMINAL_SUCCESS = [
  RECIPIENT_STATUS.SENT,
  RECIPIENT_STATUS.DELIVERED,
  RECIPIENT_STATUS.READ,
  RECIPIENT_STATUS.RESPONDED,
];

export type Guard =
  | { ok: true }
  | { ok: false; to: CampaignStatus; reason: string; detail: string };

/**
 * Everything that must still be true before another batch goes out (§8).
 *
 * Re-evaluated every tick rather than at launch, because all four conditions
 * are things that change *while* a campaign runs — a token expires, Meta
 * revokes a template, the quality rating drops after the first thousand
 * messages. A guardrail checked once is a guardrail that protects the first
 * batch and nothing after it.
 */
export const evaluateGuards = ({
  account,
  template,
  failureWindow,
  maxFailureRatePct,
}: {
  account: WhatsappAccountRecord | null;
  template: WhatsappTemplateRecord | null;
  failureWindow: FailureWindow;
  maxFailureRatePct: number;
}): Guard => {
  if (account === null || account.status !== ACCOUNT_STATUS.CONNECTED) {
    return {
      ok: false,
      to: CAMPAIGN_STATUS.PAUSED,
      reason: STATUS_REASON.ACCOUNT_ERROR,
      detail: `The sending number is ${account?.status ?? 'missing'}`,
    };
  }

  /**
   * A revoked template *fails* the campaign rather than pausing it: pausing
   * implies a resume, and there is nothing to resume to until someone submits
   * and gets a new template approved.
   */
  if (
    template === null ||
    template.status !== TEMPLATE_STATUS.APPROVED ||
    template.isUsableInCrm !== true
  ) {
    return {
      ok: false,
      to: CAMPAIGN_STATUS.FAILED,
      reason: STATUS_REASON.TEMPLATE_UNAVAILABLE,
      detail: `The template is ${template?.status ?? 'missing'}`,
    };
  }

  if (account.qualityRating === QUALITY.RED) {
    return {
      ok: false,
      to: CAMPAIGN_STATUS.PAUSED,
      reason: STATUS_REASON.QUALITY_RED,
      detail: 'Meta has rated this number RED — sending more would risk the number',
    };
  }

  if (isCircuitBroken({ window: failureWindow, maxFailureRatePct })) {
    return {
      ok: false,
      to: CAMPAIGN_STATUS.PAUSED,
      reason: STATUS_REASON.CIRCUIT_BREAKER,
      detail: `${failureWindow.failed} of the last ${failureWindow.failed + failureWindow.sent} sends failed`,
    };
  }

  return { ok: true };
};

export const failureWindowFor = async (
  campaignId: string,
  windowSize: number,
): Promise<FailureWindow> => {
  const recent = await listRecentTerminalRecipients(campaignId, windowSize);

  let sent = 0;
  let failed = 0;

  for (const recipient of recent) {
    if (recipient.status === RECIPIENT_STATUS.FAILED) failed += 1;
    else if (TERMINAL_SUCCESS.includes(recipient.status as never)) sent += 1;
  }

  return { sent, failed };
};

/**
 * Whether this tick should skip a campaign it just ticked (§6.2).
 */
export const wasTickedRecently = (
  lastRunTickAt: string | null | undefined,
  now: Date,
  intervalMs = MIN_TICK_INTERVAL_MS,
): boolean => {
  if (typeof lastRunTickAt !== 'string' || lastRunTickAt.length === 0) return false;

  const at = new Date(lastRunTickAt);

  if (Number.isNaN(at.getTime())) return false;

  return now.getTime() - at.getTime() < intervalMs;
};

export type TickOutcome = {
  queued: number;
  completed: boolean;
  paused: boolean;
};

const tickCampaign = async (
  campaign: WhatsappCampaignRecord,
  now: Date,
): Promise<TickOutcome> => {
  const log = logger.child({ fn: 'wa-campaign-runner', correlationId: campaign.id });

  const [account, template] = await Promise.all([
    typeof campaign.accountId === 'string' ? findAccountById(campaign.accountId) : null,
    typeof campaign.templateId === 'string' ? findTemplateById(campaign.templateId) : null,
  ]);

  const guard = evaluateGuards({
    account,
    template,
    failureWindow: await failureWindowFor(campaign.id, config.campaignFailureWindow()),
    maxFailureRatePct: campaign.maxFailureRatePct ?? config.campaignMaxFailureRatePct(),
  });

  if (!guard.ok) {
    log.warn('wa.campaign.guard_tripped', { reason: guard.reason, detail: guard.detail });

    await transitionCampaign({
      campaign,
      to: guard.to,
      reason: guard.reason,
      details: { detail: guard.detail },
    });

    return { queued: 0, completed: false, paused: true };
  }

  // `evaluateGuards` returned ok, so both are present.
  const connected = account!;
  const approved = template!;

  const remainingPending = await countRecipients(campaign.id, [RECIPIENT_STATUS.PENDING]);

  if (remainingPending === 0) {
    /**
     * Completion needs both halves: no pending recipients *and* nothing still
     * claimed. A campaign declared complete while a batch is mid-flight would
     * stop the runner from ever sweeping the claims back, stranding them.
     */
    const inFlight = await countRecipients(campaign.id, [RECIPIENT_STATUS.CLAIMED]);

    if (inFlight === 0) {
      await transitionCampaign({
        campaign,
        to: CAMPAIGN_STATUS.COMPLETED,
        reason: STATUS_REASON.COMPLETED,
        patch: { completedAt: now.toISOString(), lastRunTickAt: now.toISOString() },
      });

      log.info('wa.campaign.completed', { campaignId: campaign.id });

      return { queued: 0, completed: true, paused: false };
    }

    return { queued: 0, completed: false, paused: false };
  }

  const budget = budgetForAccount(connected);

  if (budget.available <= 0) {
    await transitionCampaign({
      campaign,
      to: CAMPAIGN_STATUS.TIER_WAITING,
      reason: STATUS_REASON.TIER_EXHAUSTED,
      patch: { lastRunTickAt: now.toISOString() },
      details: { limit: budget.limit, used: budget.used, reserve: budget.reserve },
    });

    return { queued: 0, completed: false, paused: false };
  }

  const batchSize = claimableCount({
    configuredBatchSize: config.campaignBatchSize(),
    available: budget.available,
    remainingPending,
  });

  const claimed = await claimPendingRecipients(campaign.id, batchSize, now);

  if (claimed.length === 0) {
    await transitionCampaign({
      campaign,
      to: CAMPAIGN_STATUS.RUNNING,
      reason: campaign.statusReason ?? null,
      patch: { lastRunTickAt: now.toISOString() },
    });

    return { queued: 0, completed: false, paused: false };
  }

  const queuedMessageIds = await queueClaimed({
    campaign,
    account: connected,
    template: approved,
    recipients: claimed,
  });

  /**
   * One scheduling call for the whole batch, not one per recipient. The lane
   * cursor is advanced once, which is what makes campaign pacing exact rather
   * than a race between however many messages happened to be enqueued (D-5).
   */
  if (queuedMessageIds.length > 0) {
    await scheduleSend({
      messageIds: queuedMessageIds,
      lane: LANE.CAMPAIGN,
      account: connected,
    });
  }

  await transitionCampaign({
    campaign,
    to: CAMPAIGN_STATUS.RUNNING,
    reason: campaign.statusReason ?? null,
    patch: {
      queuedCount: (campaign.queuedCount ?? 0) + queuedMessageIds.length,
      lastRunTickAt: now.toISOString(),
      ...(campaign.startedAt === null || campaign.startedAt === undefined
        ? { startedAt: now.toISOString() }
        : {}),
    },
  });

  log.info('wa.campaign.tick', {
    claimed: claimed.length,
    queued: queuedMessageIds.length,
    remainingPending: remainingPending - claimed.length,
  });

  count(METRIC.CAMPAIGN_QUEUED, queuedMessageIds.length);

  return { queued: queuedMessageIds.length, completed: false, paused: false };
};

/**
 * Turns claimed rows into queued messages.
 *
 * Sequential, and each recipient independently guarded: one contact whose
 * number the thread upsert rejects must not abandon the other 199 in the
 * batch. A recipient that fails here is marked `FAILED` with the reason rather
 * than left `CLAIMED`, so the sweep does not keep re-offering a row that
 * cannot be sent.
 */
const queueClaimed = async ({
  campaign,
  account,
  template,
  recipients,
}: {
  campaign: WhatsappCampaignRecord;
  account: WhatsappAccountRecord;
  template: WhatsappTemplateRecord;
  recipients: WhatsappCampaignRecipientRecord[];
}): Promise<string[]> => {
  const messageIds: string[] = [];

  for (const recipient of recipients) {
    try {
      if (typeof recipient.resolvedPhone !== 'string' || recipient.resolvedPhone.length === 0) {
        await patchRecipient(recipient.id, {
          status: RECIPIENT_STATUS.FAILED,
          errorCode: 'INTERNAL_NO_PHONE',
          errorDetail: 'The snapshot row carries no resolved number',
        });

        continue;
      }

      /**
       * The person is passed, not resolved. A campaign picked this contact out
       * of a CRM audience — there is nothing to match — and the link is what
       * lets the sender re-check *their* consent before sending, puts the
       * conversation on their record, and keeps a reply from creating a second
       * Person for someone we already had.
       */
      const { thread } = await upsertThread({
        account,
        waId: toWaId(recipient.resolvedPhone),
        personId: recipient.personId ?? null,
        originCampaignId: campaign.id,
      });

      const message = await queueOutbound({
        thread,
        account,
        spec: { kind: 'template', templateId: template.id },
        body: template.name ?? null,
        lane: LANE.CAMPAIGN,
        sourceKind: SOURCE_KIND.CAMPAIGN,
        template: {
          id: template.id,
          name: template.name ?? null,
          language: template.language ?? null,
          category: template.category ?? null,
          parameters: asJson<ResolvedParameters | null>(recipient.resolvedParameters, null),
        },
        // Paced as one batch below, not one message at a time.
        schedule: false,
      });

      await patchRecipient(recipient.id, {
        status: RECIPIENT_STATUS.QUEUED,
        threadId: thread.id,
        messageId: message.id,
      });

      messageIds.push(message.id);
    } catch (error) {
      logger.warn('wa.campaign.queue_failed', {
        correlationId: campaign.id,
        recipientId: recipient.id,
        ...describeError(error),
      });

      await patchRecipient(recipient.id, {
        status: RECIPIENT_STATUS.FAILED,
        errorCode: 'INTERNAL_QUEUE_FAILED',
        errorDetail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  }

  return messageIds;
};

/**
 * Returns claims nobody acted on (specs/07 §6.1).
 *
 * A claim is a lease, not a lock. Without this sweep a runner that died
 * mid-batch would leave rows `CLAIMED` forever and the campaign would report
 * itself running while sending nothing — the failure mode that looks most like
 * success. Only rows with no message are reverted: one that has a message was
 * queued successfully and belongs to the sender now.
 */
export const sweepStaleClaims = async (now: Date): Promise<number> => {
  const stale = await findStaleClaimedRecipients(new Date(now.getTime() - STALE_CLAIM_MS));

  const orphaned = stale.filter(
    (recipient) => typeof recipient.messageId !== 'string' || recipient.messageId.length === 0,
  );

  if (orphaned.length === 0) return 0;

  await patchRecipients(
    orphaned.map((recipient) => recipient.id),
    { status: RECIPIENT_STATUS.PENDING, claimedAt: null },
  );

  logger.warn('wa.campaign.stale_claims_reverted', { count: orphaned.length });
  count(METRIC.CAMPAIGN_STALE_CLAIM_REVERTED, orphaned.length);

  return orphaned.length;
};

export const runTick = async (now: Date = new Date()): Promise<RunnerResult> => {
  const result: RunnerResult = {
    started: 0,
    resumed: 0,
    ticked: 0,
    queued: 0,
    completed: 0,
    paused: 0,
    staleClaimsReverted: 0,
  };

  // 1. Scheduled campaigns whose time has come.
  for (const campaign of await listDueCampaigns(now)) {
    const moved = await transitionCampaign({
      campaign,
      to: CAMPAIGN_STATUS.RUNNING,
      reason: null,
      patch: { startedAt: campaign.startedAt ?? now.toISOString() },
    });

    if (moved.ok && moved.changed) result.started += 1;
  }

  /**
   * 2. Campaigns waiting on the tier, whose window has since rolled.
   *
   * Checked here rather than left to the hourly health check so a campaign
   * resumes within a minute of the allowance refreshing — FR-CAM-7's
   * "auto-resuming next cycle" measured in minutes rather than in an hour.
   */
  for (const campaign of await listCampaignsByStatus([CAMPAIGN_STATUS.TIER_WAITING])) {
    const account =
      typeof campaign.accountId === 'string' ? await findAccountById(campaign.accountId) : null;

    if (account === null) continue;

    const refreshed =
      isWindowExpired(account, now) || budgetForAccount(account).available > 0;

    if (!refreshed) continue;

    const moved = await transitionCampaign({
      campaign,
      to: CAMPAIGN_STATUS.RUNNING,
      reason: null,
    });

    if (moved.ok && moved.changed) result.resumed += 1;
  }

  // 3. Running campaigns, oldest tick first.
  const running = (await listCampaignsByStatus([CAMPAIGN_STATUS.RUNNING]))
    .filter((campaign) => !wasTickedRecently(campaign.lastRunTickAt, now))
    .slice(0, MAX_CAMPAIGNS_PER_TICK);

  for (const stale of running) {
    /**
     * Re-read immediately before acting. The list was assembled up to a few
     * seconds ago and an admin may have pressed pause since; acting on the
     * listed copy would resurrect a campaign they just stopped.
     */
    const campaign = await findCampaignById(stale.id);

    if (campaign === null || campaign.status !== CAMPAIGN_STATUS.RUNNING) continue;

    try {
      const outcome = await tickCampaign(campaign, now);

      result.ticked += 1;
      result.queued += outcome.queued;
      if (outcome.completed) result.completed += 1;
      if (outcome.paused) result.paused += 1;
    } catch (error) {
      logger.error('wa.campaign.tick_failed', {
        correlationId: campaign.id,
        ...describeError(error),
      });
    }
  }

  // 4. Claims nobody acted on.
  result.staleClaimsReverted = await sweepStaleClaims(now);

  if (
    result.started + result.resumed + result.ticked + result.staleClaimsReverted >
    0
  ) {
    logger.info('wa.campaign.runner', result);
  }

  return result;
};

export const handler = async (): Promise<RunnerResult> => runTick();

export default defineLogicFunction({
  universalIdentifier: LF_CAMPAIGN_RUNNER,
  name: 'wa-campaign-runner',
  description:
    'Starts, paces and completes campaigns: claims a batch of recipients each minute, queues their messages, and sweeps stale claims.',
  timeoutSeconds: 120,
  cronTriggerSettings: { pattern: '* * * * *' },
  handler,
});
