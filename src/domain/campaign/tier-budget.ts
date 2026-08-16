import { MESSAGING_TIER, TEMPLATE_CATEGORY, type MessagingTier, type TemplateCategory } from '../constants';

/**
 * The messaging-tier ledger (AR-21).
 *
 * Meta counts **unique users messaged business-initiated in a rolling 24 hours**,
 * from every source — campaigns, workflow sends and rep-initiated templates
 * alike. A campaign that ignored 1:1 traffic would exhaust the allowance and
 * leave a rep unable to reach a customer at 4pm, which is what the reserve
 * exists to prevent.
 */

export const TIER_LIMITS: Record<MessagingTier, number> = {
  [MESSAGING_TIER.TIER_250]: 250,
  [MESSAGING_TIER.TIER_1K]: 1_000,
  [MESSAGING_TIER.TIER_2K]: 2_000,
  [MESSAGING_TIER.TIER_10K]: 10_000,
  [MESSAGING_TIER.TIER_100K]: 100_000,
  [MESSAGING_TIER.TIER_UNLIMITED]: Number.POSITIVE_INFINITY,
};

export type TierBudget = {
  limit: number;
  used: number;
  /** Held back for interactive traffic. */
  reserve: number;
  /** What a campaign may consume right now. */
  available: number;
};

export const tierBudget = ({
  tier,
  used,
  reservePct,
}: {
  tier: MessagingTier;
  used: number;
  reservePct: number;
}): TierBudget => {
  const limit = TIER_LIMITS[tier];

  if (!Number.isFinite(limit)) {
    return { limit, used, reserve: 0, available: Number.POSITIVE_INFINITY };
  }

  const reserve = Math.ceil((limit * reservePct) / 100);

  return { limit, used, reserve, available: Math.max(0, limit - used - reserve) };
};

/**
 * Whether a send consumes tier allowance (AR-21).
 *
 * Meta counts *business-initiated* conversations: a template sent outside an
 * open service window, and any marketing template regardless of the window —
 * marketing is business-initiated by definition, even to someone who wrote in
 * five minutes ago.
 *
 * A free-form reply inside the window never counts, which is exactly why the
 * reserve protects it: the tier is spent by campaigns and template sends, and
 * the traffic it must not starve is the traffic that does not consume it.
 */
export const isBusinessInitiated = ({
  isTemplate,
  templateCategory,
  windowOpen,
}: {
  isTemplate: boolean;
  templateCategory?: TemplateCategory | null;
  windowOpen: boolean;
}): boolean => {
  if (!isTemplate) return false;

  return templateCategory === TEMPLATE_CATEGORY.MARKETING || !windowOpen;
};

/** A rolling window, not a calendar day: it rolls 24h after it started. */
export const isTierWindowExpired = (
  windowStartedAt: Date | null | undefined,
  now: Date,
  windowHours = 24,
): boolean => {
  if (!(windowStartedAt instanceof Date)) return true;

  return now.getTime() - windowStartedAt.getTime() >= windowHours * 3_600_000;
};

/**
 * How the pre-flight panel explains a campaign larger than one day's allowance
 * (FR-CAM-6) — "1 000 recipients, 225 today, completing in 4 days" is the
 * difference between an informed launch and a support ticket.
 */
export const projectDailySpread = ({
  recipientCount,
  availablePerDay,
}: {
  recipientCount: number;
  availablePerDay: number;
}): { firstDay: number; days: number } => {
  if (recipientCount <= 0) return { firstDay: 0, days: 0 };
  if (!Number.isFinite(availablePerDay)) return { firstDay: recipientCount, days: 1 };
  if (availablePerDay <= 0) return { firstDay: 0, days: Number.POSITIVE_INFINITY };

  return {
    firstDay: Math.min(recipientCount, availablePerDay),
    days: Math.ceil(recipientCount / availablePerDay),
  };
};

/** The batch size a runner tick may claim: never more than the budget allows. */
export const claimableCount = ({
  configuredBatchSize,
  available,
  remainingPending,
}: {
  configuredBatchSize: number;
  available: number;
  remainingPending: number;
}): number =>
  Math.max(0, Math.min(configuredBatchSize, available, remainingPending));
