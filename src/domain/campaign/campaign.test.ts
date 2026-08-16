import { describe, expect, it } from 'vitest';

import {
  CONSENT_STATUS,
  EXCLUSION_REASON,
  MESSAGING_TIER,
  TEMPLATE_CATEGORY,
  type TemplateCategory,
} from '../constants';
import { emptyBreakdown, evaluateExclusion, tallyExclusion, type ExclusionCandidate } from './exclusions';
import {
  DEFAULT_RATES,
  estimateCampaignCostUsd,
  failureRatePct,
  isCircuitBroken,
  looksLikeMetaPacing,
  rateFor,
} from './guardrails';
import {
  TIER_LIMITS,
  claimableCount,
  isTierWindowExpired,
  projectDailySpread,
  tierBudget,
} from './tier-budget';

const candidate = (o: Partial<ExclusionCandidate> = {}): ExclusionCandidate => ({
  personId: 'p1',
  primaryPhone: '923000000',
  consent: CONSENT_STATUS.OPTED_IN,
  ...o,
});

const evaluate = (
  c: Partial<ExclusionCandidate>,
  category: TemplateCategory = TEMPLATE_CATEGORY.MARKETING,
  seen: Set<string> = new Set(),
) =>
  evaluateExclusion({
    candidate: candidate(c),
    templateCategory: category,
    defaultCallingCode: '+244',
    seenPhones: seen,
  });

describe('evaluateExclusion', () => {
  it('accepts an opted-in contact with a valid number', () => {
    expect(evaluate({})).toEqual({ excluded: false, phone: '+244923000000' });
  });

  it.each([
    ['opted out', { consent: CONSENT_STATUS.OPTED_OUT }, EXCLUSION_REASON.OPTED_OUT],
    ['unknown consent', { consent: CONSENT_STATUS.UNKNOWN }, EXCLUSION_REASON.NO_CONSENT],
    ['no phone', { primaryPhone: null }, EXCLUSION_REASON.INVALID_PHONE],
    ['unparseable phone', { primaryPhone: 'not a number' }, EXCLUSION_REASON.INVALID_PHONE],
    ['blocked thread', { threadIsBlocked: true }, EXCLUSION_REASON.BLOCKED],
    ['missing variables', { missingVariables: ['{{2}}'] }, EXCLUSION_REASON.MISSING_VARIABLES],
  ])('excludes %s', (_label, overrides, reason) => {
    expect(evaluate(overrides)).toMatchObject({ excluded: true, reason });
  });

  it('excludes a duplicate, keeping the first occurrence', () => {
    expect(evaluate({}, TEMPLATE_CATEGORY.MARKETING, new Set(['+244923000000']))).toMatchObject({
      excluded: true,
      reason: EXCLUSION_REASON.DUPLICATE,
    });
  });

  it('falls back to an additional phone when the primary is unusable', () => {
    expect(evaluate({ primaryPhone: null, additionalPhones: ['+244911111111'] })).toEqual({
      excluded: false,
      phone: '+244911111111',
    });
  });

  /**
   * The distinction that makes operational bulk sends possible: utility
   * templates are transactional and need only the absence of an opt-out, while
   * marketing requires an explicit opt-in (FR-CAM-5).
   */
  describe('category changes the consent rule', () => {
    it('admits unknown consent to a utility campaign', () => {
      expect(
        evaluate({ consent: CONSENT_STATUS.UNKNOWN }, TEMPLATE_CATEGORY.UTILITY).excluded,
      ).toBe(false);
    });

    it('still excludes opted-out from a utility campaign', () => {
      expect(
        evaluate({ consent: CONSENT_STATUS.OPTED_OUT }, TEMPLATE_CATEGORY.UTILITY),
      ).toMatchObject({ reason: EXCLUSION_REASON.OPTED_OUT });
    });
  });

  describe('precedence', () => {
    /** "We may not message them" is more actionable than "their number is wrong". */
    it('reports consent ahead of an invalid phone', () => {
      expect(
        evaluate({ consent: CONSENT_STATUS.OPTED_OUT, primaryPhone: 'rubbish' }),
      ).toMatchObject({ reason: EXCLUSION_REASON.OPTED_OUT });
    });

    it('reports an invalid phone ahead of a duplicate', () => {
      expect(
        evaluate({ primaryPhone: null }, TEMPLATE_CATEGORY.MARKETING, new Set(['+244923000000'])),
      ).toMatchObject({ reason: EXCLUSION_REASON.INVALID_PHONE });
    });

    it('reports a duplicate ahead of missing variables', () => {
      expect(
        evaluate({ missingVariables: ['{{1}}'] }, TEMPLATE_CATEGORY.MARKETING, new Set(['+244923000000'])),
      ).toMatchObject({ reason: EXCLUSION_REASON.DUPLICATE });
    });
  });

  it('reports the resolved phone even when excluding, so the row is auditable', () => {
    expect(evaluate({ consent: CONSENT_STATUS.OPTED_OUT }).phone).toBe('+244923000000');
  });
});

describe('exclusion breakdown', () => {
  it('starts at zero for every reason', () => {
    expect(Object.values(emptyBreakdown()).every((n) => n === 0)).toBe(true);
  });

  it('tallies without mutating', () => {
    const start = emptyBreakdown();
    const next = tallyExclusion(start, EXCLUSION_REASON.OPTED_OUT);

    expect(next[EXCLUSION_REASON.OPTED_OUT]).toBe(1);
    expect(start[EXCLUSION_REASON.OPTED_OUT]).toBe(0);
  });
});

describe('tierBudget', () => {
  it('holds back the reserve so a campaign cannot consume the whole allowance', () => {
    expect(tierBudget({ tier: MESSAGING_TIER.TIER_250, used: 0, reservePct: 10 })).toEqual({
      limit: 250,
      used: 0,
      reserve: 25,
      available: 225,
    });
  });

  it('never reports negative availability', () => {
    expect(
      tierBudget({ tier: MESSAGING_TIER.TIER_250, used: 300, reservePct: 10 }).available,
    ).toBe(0);
  });

  it('treats the unlimited tier as unbounded', () => {
    const b = tierBudget({ tier: MESSAGING_TIER.TIER_UNLIMITED, used: 999_999, reservePct: 10 });
    expect(b.available).toBe(Number.POSITIVE_INFINITY);
  });

  it('rounds the reserve up, never leaving it short', () => {
    expect(tierBudget({ tier: MESSAGING_TIER.TIER_250, used: 0, reservePct: 1 }).reserve).toBe(3);
  });

  it('exposes every Meta tier', () => {
    expect(Object.keys(TIER_LIMITS)).toHaveLength(6);
  });

  /** Meta can lower a tier mid-run; availability must shrink immediately. */
  it('shrinks when Meta reports a lower tier', () => {
    const before = tierBudget({ tier: MESSAGING_TIER.TIER_10K, used: 500, reservePct: 10 });
    const after = tierBudget({ tier: MESSAGING_TIER.TIER_1K, used: 500, reservePct: 10 });
    expect(after.available).toBeLessThan(before.available);
  });
});

describe('isTierWindowExpired', () => {
  const now = new Date('2026-08-15T10:00:00Z');

  it('is expired at exactly 24 hours', () => {
    expect(isTierWindowExpired(new Date('2026-08-14T10:00:00Z'), now)).toBe(true);
  });

  it('is not expired just short of 24 hours', () => {
    expect(isTierWindowExpired(new Date('2026-08-14T10:00:01Z'), now)).toBe(false);
  });

  it('treats a missing start as expired, so the first tick opens a window', () => {
    expect(isTierWindowExpired(null, now)).toBe(true);
  });
});

describe('projectDailySpread', () => {
  /** The R-10 scenario the pre-flight panel must explain. */
  it('spreads a 1 000-recipient campaign across days on the 250 tier', () => {
    expect(projectDailySpread({ recipientCount: 1000, availablePerDay: 225 })).toEqual({
      firstDay: 225,
      days: 5,
    });
  });

  it('completes in one day when the audience fits', () => {
    expect(projectDailySpread({ recipientCount: 100, availablePerDay: 225 })).toEqual({
      firstDay: 100,
      days: 1,
    });
  });

  it('reports never-completing when nothing is available', () => {
    expect(projectDailySpread({ recipientCount: 100, availablePerDay: 0 }).days).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('handles an unlimited tier', () => {
    expect(
      projectDailySpread({ recipientCount: 5000, availablePerDay: Number.POSITIVE_INFINITY }),
    ).toEqual({ firstDay: 5000, days: 1 });
  });
});

describe('claimableCount', () => {
  it('is bounded by the smallest of batch size, budget and remaining work', () => {
    expect(claimableCount({ configuredBatchSize: 200, available: 50, remainingPending: 500 })).toBe(50);
    expect(claimableCount({ configuredBatchSize: 200, available: 500, remainingPending: 30 })).toBe(30);
    expect(claimableCount({ configuredBatchSize: 20, available: 500, remainingPending: 500 })).toBe(20);
  });

  it('never returns negative', () => {
    expect(claimableCount({ configuredBatchSize: 200, available: -5, remainingPending: 10 })).toBe(0);
  });
});

describe('isCircuitBroken', () => {
  it('trips above the threshold', () => {
    expect(isCircuitBroken({ window: { sent: 80, failed: 20 }, maxFailureRatePct: 10 })).toBe(true);
  });

  it('does not trip at exactly the threshold', () => {
    expect(isCircuitBroken({ window: { sent: 90, failed: 10 }, maxFailureRatePct: 10 })).toBe(false);
  });

  /**
   * Without a minimum sample, one failure in a 5-recipient campaign reads as a
   * 100% failure rate and pauses a campaign that is working fine.
   */
  it('ignores a small sample', () => {
    expect(isCircuitBroken({ window: { sent: 0, failed: 1 }, maxFailureRatePct: 10 })).toBe(false);
    expect(isCircuitBroken({ window: { sent: 2, failed: 3 }, maxFailureRatePct: 10 })).toBe(false);
  });

  it('trips once the sample is large enough', () => {
    expect(isCircuitBroken({ window: { sent: 0, failed: 10 }, maxFailureRatePct: 10 })).toBe(true);
  });

  it('reports zero for an empty window rather than dividing by zero', () => {
    expect(failureRatePct({ sent: 0, failed: 0 })).toBe(0);
  });
});

describe('cost model', () => {
  it('uses the category rate', () => {
    expect(rateFor(TEMPLATE_CATEGORY.MARKETING)).toBe(DEFAULT_RATES.marketingUsd);
    expect(rateFor(TEMPLATE_CATEGORY.UTILITY)).toBe(DEFAULT_RATES.utilityUsd);
  });

  /** The worked example from Appendix B. */
  it('estimates a 1 000-recipient marketing campaign at $22.50', () => {
    expect(
      estimateCampaignCostUsd({ recipientCount: 1000, category: TEMPLATE_CATEGORY.MARKETING }),
    ).toBe(22.5);
  });

  it('honours corrected rates without a code change', () => {
    expect(
      estimateCampaignCostUsd({
        recipientCount: 1000,
        category: TEMPLATE_CATEGORY.MARKETING,
        rates: { ...DEFAULT_RATES, marketingUsd: 0.03 },
      }),
    ).toBe(30);
  });

  it('is zero for an empty audience', () => {
    expect(estimateCampaignCostUsd({ recipientCount: 0, category: TEMPLATE_CATEGORY.MARKETING })).toBe(0);
  });
});

describe('looksLikeMetaPacing', () => {
  it('detects a stalled batch after the minimum elapsed time', () => {
    expect(
      looksLikeMetaPacing({ queued: 100, acceptedWithoutSentStatus: 30, elapsedMs: 20 * 60_000 }),
    ).toBe(true);
  });

  it('does not fire too early, when statuses are simply still arriving', () => {
    expect(
      looksLikeMetaPacing({ queued: 100, acceptedWithoutSentStatus: 90, elapsedMs: 60_000 }),
    ).toBe(false);
  });

  it('does not fire when delivery is progressing normally', () => {
    expect(
      looksLikeMetaPacing({ queued: 100, acceptedWithoutSentStatus: 5, elapsedMs: 20 * 60_000 }),
    ).toBe(false);
  });

  it('handles an empty batch', () => {
    expect(
      looksLikeMetaPacing({ queued: 0, acceptedWithoutSentStatus: 0, elapsedMs: 20 * 60_000 }),
    ).toBe(false);
  });
});
