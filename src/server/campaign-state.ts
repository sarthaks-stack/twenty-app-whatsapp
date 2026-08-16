import { canTransition } from '../domain/campaign/transitions';
import { CAMPAIGN_STATUS, type CampaignStatus } from '../domain/constants';
import { AUDIT_ACTION, audit, type AuditAction } from './audit';
import { logger } from './logger';
import {
  patchCampaign,
  type CampaignPatch,
  type WhatsappCampaignRecord,
} from './repositories/campaigns';

/**
 * The one place a campaign's status changes (specs/07 §1).
 *
 * Two functions move campaigns — `wa-campaign-control` for what a human asks
 * for, `wa-campaign-runner` for what the machine decides — and they run
 * concurrently by design: an admin can press pause while a tick is claiming a
 * batch. Without a shared gate the two would race to write contradictory
 * statuses, and the loser would be whichever one the operator was watching.
 *
 * So every transition validates the edge against the state it *read*, writes
 * the reason, and audits. The validation is not a formality: it is what makes
 * "cancel is final" and "a completed campaign cannot resume" true rather than
 * merely intended.
 */

const AUDITED: Partial<Record<CampaignStatus, AuditAction>> = {
  [CAMPAIGN_STATUS.RUNNING]: AUDIT_ACTION.CAMPAIGN_LAUNCH,
  [CAMPAIGN_STATUS.SCHEDULED]: AUDIT_ACTION.CAMPAIGN_LAUNCH,
  [CAMPAIGN_STATUS.PAUSED]: AUDIT_ACTION.CAMPAIGN_PAUSE,
  [CAMPAIGN_STATUS.CANCELLED]: AUDIT_ACTION.CAMPAIGN_CANCEL,
};

export type TransitionResult =
  | { ok: true; changed: boolean; from: CampaignStatus; to: CampaignStatus }
  | { ok: false; reason: string; from: CampaignStatus };

export const transitionCampaign = async ({
  campaign,
  to,
  reason = null,
  actorId = null,
  patch = {},
  details = {},
}: {
  campaign: WhatsappCampaignRecord;
  to: CampaignStatus;
  /** What goes in `statusReason`; null clears it. */
  reason?: string | null;
  actorId?: string | null;
  /** Fields written in the same call — counts, timestamps, the audience. */
  patch?: CampaignPatch;
  details?: Record<string, unknown>;
}): Promise<TransitionResult> => {
  const from = (campaign.status ?? CAMPAIGN_STATUS.DRAFT) as CampaignStatus;
  const verdict = canTransition(from, to);

  if (!verdict.ok) {
    logger.warn('wa.campaign.transition_refused', {
      correlationId: campaign.id,
      from,
      to,
      reason: verdict.reason,
    });

    return { ok: false, reason: verdict.reason, from };
  }

  /**
   * A no-op still applies `patch`. Repeating `pause` on a paused campaign must
   * not error (FR-CAM-8), but a runner tick that reports "no change of state,
   * 40 more queued" is carrying real information, and dropping the patch to
   * keep the idempotence tidy would lose it.
   */
  await patchCampaign(campaign.id, {
    ...patch,
    ...(verdict.noop ? {} : { status: to }),
    ...(reason === undefined ? {} : { statusReason: reason }),
  });

  const auditAction = verdict.noop ? undefined : AUDITED[to];

  if (auditAction !== undefined) {
    audit({
      action: auditAction,
      actorId,
      subject: { campaignId: campaign.id, templateId: campaign.templateId ?? null, accountId: campaign.accountId ?? null },
      details: { from, to, reason, name: campaign.name ?? null, ...details },
    });
  }

  logger.info('wa.campaign.transition', {
    correlationId: campaign.id,
    from,
    to,
    noop: verdict.noop,
    reason,
  });

  return { ok: true, changed: !verdict.noop, from, to };
};
