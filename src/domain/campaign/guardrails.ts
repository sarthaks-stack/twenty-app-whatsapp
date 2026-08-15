import { TEMPLATE_CATEGORY, type TemplateCategory } from '../constants';

/**
 * Campaign guardrails (AR-22) and the cost model (Appendix B).
 */

export type FailureWindow = { sent: number; failed: number };

/**
 * Trips when the failure rate over the recent window exceeds the threshold.
 *
 * Requires a minimum sample: without it a 5-recipient campaign whose first
 * message fails would pause at a 100% "rate", which is noise rather than
 * signal. Computed from recipient rows rather than a running counter, so a
 * pause and resume does not reset the safety net.
 */
export const isCircuitBroken = ({
  window,
  maxFailureRatePct,
  minimumSample = 10,
}: {
  window: FailureWindow;
  maxFailureRatePct: number;
  minimumSample?: number;
}): boolean => {
  const total = window.sent + window.failed;
  if (total < minimumSample) return false;

  return (window.failed / total) * 100 > maxFailureRatePct;
};

export const failureRatePct = (window: FailureWindow): number => {
  const total = window.sent + window.failed;

  return total === 0 ? 0 : (window.failed / total) * 100;
};

export type Rates = {
  marketingUsd: number;
  utilityUsd: number;
  authenticationUsd: number;
};

export const DEFAULT_RATES: Rates = {
  marketingUsd: 0.0225,
  utilityUsd: 0.004,
  authenticationUsd: 0.004,
};

export const rateFor = (category: TemplateCategory, rates: Rates = DEFAULT_RATES): number => {
  switch (category) {
    case TEMPLATE_CATEGORY.MARKETING:
      return rates.marketingUsd;
    case TEMPLATE_CATEGORY.UTILITY:
      return rates.utilityUsd;
    case TEMPLATE_CATEGORY.AUTHENTICATION:
      return rates.authenticationUsd;
    default:
      return 0;
  }
};

/**
 * Pre-flight estimate. Deliberately the *upper bound*: Meta bills on delivery,
 * so actuals land slightly lower, and the UI labels both rather than pretending
 * the estimate is a quote.
 */
export const estimateCampaignCostUsd = ({
  recipientCount,
  category,
  rates = DEFAULT_RATES,
}: {
  recipientCount: number;
  category: TemplateCategory;
  rates?: Rates;
}): number => Math.round(recipientCount * rateFor(category, rates) * 10_000) / 10_000;

/**
 * Meta intentionally slows large marketing batches to gather early engagement
 * signals. Surfacing it as a state rather than an error is the difference
 * between an informed stakeholder and a false alarm (FR-CAM-11, R-12).
 */
export const looksLikeMetaPacing = ({
  queued,
  acceptedWithoutSentStatus,
  elapsedMs,
  thresholdPct = 20,
  minimumElapsedMs = 15 * 60_000,
}: {
  queued: number;
  acceptedWithoutSentStatus: number;
  elapsedMs: number;
  thresholdPct?: number;
  minimumElapsedMs?: number;
}): boolean => {
  if (elapsedMs < minimumElapsedMs || queued === 0) return false;

  return (acceptedWithoutSentStatus / queued) * 100 >= thresholdPct;
};
