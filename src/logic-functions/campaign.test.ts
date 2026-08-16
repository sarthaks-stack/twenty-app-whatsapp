import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyBreakdown } from '../domain/campaign/exclusions';
import {
  ACCOUNT_STATUS,
  CAMPAIGN_STATUS,
  CONSENT_STATUS,
  EXCLUSION_REASON,
  QUALITY,
  RECIPIENT_STATUS,
  TEMPLATE_CATEGORY,
  TEMPLATE_STATUS,
  type TemplateCategory,
} from '../domain/constants';
import type { VariableSpec } from '../domain/template-spec';
import { personPhones } from '../server/audience';
import {
  MAX_TEST_RECIPIENTS,
  launchGate,
  templateRefusal,
} from './wa-campaign-control';
import {
  MAX_CAMPAIGNS_PER_TICK,
  MIN_TICK_INTERVAL_MS,
  STALE_CLAIM_MS,
  evaluateGuards,
  failureWindowFor,
  wasTickedRecently,
} from './wa-campaign-runner';
import { MAX_PAGES, PAGE_DELAY_MS, decidePage, emptyStats } from './wa-campaign-snapshot';
import { FUNNEL } from './wa-stats-rollup';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const NOW = new Date('2026-08-16T09:30:00.000Z');

/** One body variable bound to the contact's first name — the common shape. */
const SPEC: VariableSpec = {
  namedParameters: false,
  header: null,
  body: { variableCount: 1, indices: [1], names: [], text: 'Olá {{1}}', example: [] },
  footer: null,
  buttons: [],
  totalVariableCount: 1,
};

const MAPPING = {
  body: [{ index: 1, kind: 'field' as const, path: 'person.name.firstName' }],
};

const person = (
  id: string,
  {
    firstName = 'Ana',
    number = '923000001',
    callingCode = '+244',
    consent = CONSENT_STATUS.OPTED_IN,
  }: {
    firstName?: string | null;
    number?: string | null;
    callingCode?: string;
    consent?: string;
  } = {},
) => ({
  id,
  name: { firstName, lastName: 'Silva' },
  phones:
    number === null
      ? null
      : { primaryPhoneNumber: number, primaryPhoneCallingCode: callingCode },
  whatsappOptInStatus: consent,
});

const decide = (
  people: ReturnType<typeof person>[],
  {
    category = TEMPLATE_CATEGORY.MARKETING as TemplateCategory,
    blocked = new Set<string>(),
    seen = new Set<string>(),
  }: { category?: TemplateCategory; blocked?: Set<string>; seen?: Set<string> } = {},
) =>
  decidePage({
    people: people as never,
    campaignId: 'c1',
    templateCategory: category,
    spec: SPEC,
    mapping: MAPPING,
    defaultCallingCode: '+244',
    accountDisplayName: 'Pixel',
    blockedWaIds: blocked,
    seenPhones: seen,
    now: NOW,
    stats: emptyStats(),
  });

describe('reading the numbers off a Person', () => {
  it('recombines the calling code with the national number', () => {
    expect(personPhones(person('p1') as never).primary).toBe('+244923000001');
  });

  it('answers null when there is no number at all', () => {
    expect(personPhones(person('p1', { number: null }) as never).primary).toBeNull();
  });

  /**
   * `additionalPhones` is RAW_JSON with no enforced shape. Misreading it costs a
   * contact excluded as `invalid_phone` who has a perfectly good number.
   */
  it('reads additional phones written as objects', () => {
    expect(
      personPhones({
        id: 'p',
        phones: {
          primaryPhoneNumber: '923000001',
          primaryPhoneCallingCode: '+244',
          additionalPhones: [{ number: '924000002', callingCode: '+244' }],
        },
      } as never).additional,
    ).toEqual(['+244924000002']);
  });

  it('reads additional phones written as bare strings', () => {
    expect(
      personPhones({
        id: 'p',
        phones: { additionalPhones: ['+244924000002'] },
      } as never).additional,
    ).toEqual(['+244924000002']);
  });

  it('reads additional phones stored as a JSON string', () => {
    expect(
      personPhones({
        id: 'p',
        phones: { additionalPhones: '[{"number":"924000002","callingCode":"+244"}]' },
      } as never).additional,
    ).toEqual(['+244924000002']);
  });
});

describe('the exclusion matrix over a page', () => {
  it('accepts an opted-in contact with a good number', () => {
    const { rows, stats } = decide([person('p1')]);

    expect(stats).toMatchObject({ scanned: 1, accepted: 1, excluded: 0 });
    expect(rows[0]).toMatchObject({
      personId: 'p1',
      status: RECIPIENT_STATUS.PENDING,
      resolvedPhone: '+244923000001',
      exclusionReason: null,
    });
  });

  it('freezes the resolved parameters onto the row', () => {
    const { rows } = decide([person('p1', { firstName: 'Ana' })]);

    expect(rows[0]!.resolvedParameters).toMatchObject({ body: ['Ana'] });
  });

  /**
   * The highest-consequence line in the campaign path. Marketing needs an
   * explicit opt-in, so `unknown` is excluded rather than warned about
   * (FR-CAM-5): getting this backwards messages people who never agreed.
   */
  it('excludes an unknown-consent contact from a marketing campaign', () => {
    const { rows, stats } = decide([person('p1', { consent: CONSENT_STATUS.UNKNOWN })]);

    expect(rows[0]).toMatchObject({
      status: RECIPIENT_STATUS.EXCLUDED,
      exclusionReason: EXCLUSION_REASON.NO_CONSENT,
    });
    expect(stats.breakdown[EXCLUSION_REASON.NO_CONSENT]).toBe(1);
  });

  /** A utility campaign is transactional, so absence of an opt-out is enough. */
  it('accepts the same contact for a utility campaign', () => {
    const { stats } = decide([person('p1', { consent: CONSENT_STATUS.UNKNOWN })], {
      category: TEMPLATE_CATEGORY.UTILITY,
    });

    expect(stats.accepted).toBe(1);
  });

  it('excludes an opted-out contact from a utility campaign too', () => {
    const { rows } = decide([person('p1', { consent: CONSENT_STATUS.OPTED_OUT })], {
      category: TEMPLATE_CATEGORY.UTILITY,
    });

    expect(rows[0]!.exclusionReason).toBe(EXCLUSION_REASON.OPTED_OUT);
  });

  it('excludes a contact with no usable number', () => {
    const { rows } = decide([person('p1', { number: null })]);

    expect(rows[0]).toMatchObject({
      exclusionReason: EXCLUSION_REASON.INVALID_PHONE,
      resolvedPhone: null,
    });
  });

  /** First occurrence in scan order wins, within a page as across them. */
  it('excludes the second of two people sharing a number', () => {
    const { rows, stats } = decide([person('p1'), person('p2')]);

    expect(rows[0]!.exclusionReason).toBeNull();
    expect(rows[1]!.exclusionReason).toBe(EXCLUSION_REASON.DUPLICATE);
    expect(stats.accepted).toBe(1);
  });

  it('excludes a number already accepted on an earlier page', () => {
    const { rows } = decide([person('p1')], { seen: new Set(['+244923000001']) });

    expect(rows[0]!.exclusionReason).toBe(EXCLUSION_REASON.DUPLICATE);
  });

  it('excludes a number a human has blocked', () => {
    const { rows } = decide([person('p1')], { blocked: new Set(['244923000001']) });

    expect(rows[0]!.exclusionReason).toBe(EXCLUSION_REASON.BLOCKED);
  });

  /** A template we cannot fill would be rejected by Meta for every recipient. */
  it('excludes a contact whose variable cannot be resolved', () => {
    const { rows } = decide([person('p1', { firstName: null })]);

    expect(rows[0]!.exclusionReason).toBe(EXCLUSION_REASON.MISSING_VARIABLES);
  });

  /** FR-CAM-4: a fallback makes an empty resolution a non-event. */
  it('accepts the same contact when the binding has a fallback', () => {
    const { stats } = decidePage({
      people: [person('p1', { firstName: null })] as never,
      campaignId: 'c1',
      templateCategory: TEMPLATE_CATEGORY.MARKETING,
      spec: SPEC,
      mapping: {
        body: [
          { index: 1, kind: 'field', path: 'person.name.firstName', fallback: 'cliente' },
        ],
      },
      defaultCallingCode: '+244',
      accountDisplayName: 'Pixel',
      blockedWaIds: new Set(),
      seenPhones: new Set(),
      now: NOW,
      stats: emptyStats(),
    });

    expect(stats.accepted).toBe(1);
  });

  /** Excluded people are rows, not omissions — that is what makes it auditable. */
  it('writes a row for every person it scans', () => {
    const { rows, stats } = decide([
      person('p1'),
      person('p2', { number: '924000002', consent: CONSENT_STATUS.OPTED_OUT }),
      person('p3', { number: null }),
    ]);

    expect(rows).toHaveLength(3);
    expect(stats).toMatchObject({ scanned: 3, accepted: 1, excluded: 2 });
  });

  it('carries the running totals across pages', () => {
    const first = decide([person('p1')]);
    const second = decidePage({
      people: [person('p2', { number: '924000002' })] as never,
      campaignId: 'c1',
      templateCategory: TEMPLATE_CATEGORY.MARKETING,
      spec: SPEC,
      mapping: MAPPING,
      defaultCallingCode: '+244',
      accountDisplayName: 'Pixel',
      blockedWaIds: new Set(),
      seenPhones: new Set(),
      now: NOW,
      stats: first.stats,
    });

    expect(second.stats).toMatchObject({ scanned: 2, accepted: 2 });
  });

  it('starts from an empty breakdown that names every reason', () => {
    expect(Object.keys(emptyStats().breakdown).sort()).toEqual(
      Object.values(EXCLUSION_REASON).sort(),
    );
    expect(Object.values(emptyBreakdown()).every((value) => value === 0)).toBe(true);
  });
});

describe('the runner guardrails', () => {
  const account = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'a1',
      status: ACCOUNT_STATUS.CONNECTED,
      qualityRating: QUALITY.GREEN,
      ...overrides,
    }) as never;

  const template = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 't1',
      status: TEMPLATE_STATUS.APPROVED,
      isUsableInCrm: true,
      ...overrides,
    }) as never;

  const guards = (overrides: Record<string, unknown> = {}) =>
    evaluateGuards({
      account: account(),
      template: template(),
      failureWindow: { sent: 100, failed: 0 },
      maxFailureRatePct: 10,
      ...overrides,
    } as never);

  it('lets a healthy campaign through', () => {
    expect(guards()).toEqual({ ok: true });
  });

  it('pauses when the sending number is in error', () => {
    const verdict = guards({ account: account({ status: ACCOUNT_STATUS.ERROR }) });

    expect(verdict).toMatchObject({ ok: false, to: CAMPAIGN_STATUS.PAUSED });
  });

  /**
   * A revoked template fails rather than pauses: pausing implies a resume, and
   * there is nothing to resume to until a new template is approved.
   */
  it('fails when the template is no longer approved', () => {
    const verdict = guards({ template: template({ status: TEMPLATE_STATUS.REJECTED }) });

    expect(verdict).toMatchObject({ ok: false, to: CAMPAIGN_STATUS.FAILED });
  });

  it('fails when the template is approved but unusable from the CRM', () => {
    const verdict = guards({ template: template({ isUsableInCrm: false }) });

    expect(verdict).toMatchObject({ ok: false, to: CAMPAIGN_STATUS.FAILED });
  });

  it('pauses on a RED quality rating', () => {
    const verdict = guards({ account: account({ qualityRating: QUALITY.RED }) });

    expect(verdict).toMatchObject({ ok: false, to: CAMPAIGN_STATUS.PAUSED });
  });

  it('pauses when the failure rate exceeds the threshold', () => {
    const verdict = guards({ failureWindow: { sent: 80, failed: 20 } });

    expect(verdict).toMatchObject({ ok: false, to: CAMPAIGN_STATUS.PAUSED });
  });

  /**
   * A five-recipient campaign whose first message fails is not a 100% failure
   * rate, it is one failure. Without a minimum sample the breaker would pause
   * every small campaign that stumbled once.
   */
  it('does not trip on a tiny sample', () => {
    expect(guards({ failureWindow: { sent: 1, failed: 2 } })).toEqual({ ok: true });
  });
});

describe('tick spacing', () => {
  it('skips a campaign ticked seconds ago', () => {
    const at = new Date(NOW.getTime() - 5_000).toISOString();

    expect(wasTickedRecently(at, NOW)).toBe(true);
  });

  it('runs a campaign ticked a minute ago', () => {
    const at = new Date(NOW.getTime() - 60_000).toISOString();

    expect(wasTickedRecently(at, NOW)).toBe(false);
  });

  /** A campaign that has never ticked must run, not be skipped as "recent". */
  it('runs a campaign that has never ticked', () => {
    expect(wasTickedRecently(null, NOW)).toBe(false);
    expect(wasTickedRecently('not a date', NOW)).toBe(false);
  });

  it('keeps the interval below the cron period so a normal minute never trips', () => {
    expect(MIN_TICK_INTERVAL_MS).toBeLessThan(60_000);
    expect(MAX_CAMPAIGNS_PER_TICK).toBe(3);
    expect(STALE_CLAIM_MS).toBe(10 * 60_000);
  });
});

describe('the launch gate', () => {
  it('blocks a RED number outright', () => {
    const gate = launchGate({ qualityRating: QUALITY.RED } as never, true);

    expect(gate.allowed).toBe(false);
  });

  it('blocks a YELLOW number until the admin acknowledges', () => {
    expect(launchGate({ qualityRating: QUALITY.YELLOW } as never, false).allowed).toBe(false);
    expect(launchGate({ qualityRating: QUALITY.YELLOW } as never, true).allowed).toBe(true);
  });

  it('allows a GREEN number with no warning', () => {
    expect(launchGate({ qualityRating: QUALITY.GREEN } as never, false)).toEqual({
      allowed: true,
      warning: null,
    });
  });

  it('blocks a campaign with no sending number', () => {
    expect(launchGate(null, true).allowed).toBe(false);
  });
});

describe('which templates may carry a campaign', () => {
  const usable = {
    id: 't1',
    status: TEMPLATE_STATUS.APPROVED,
    publishedToCrm: true,
    isUsableInCrm: true,
    category: TEMPLATE_CATEGORY.MARKETING,
  } as never;

  it('accepts an approved, published, usable marketing template', () => {
    expect(templateRefusal(usable)).toBeNull();
  });

  it('refuses an unpublished template', () => {
    expect(templateRefusal({ ...(usable as object), publishedToCrm: false } as never)).toContain(
      'not been published',
    );
  });

  it('refuses a pending template', () => {
    expect(
      templateRefusal({ ...(usable as object), status: TEMPLATE_STATUS.PENDING } as never),
    ).toContain('not approved');
  });

  /**
   * An OTP template has no bulk use case. Sending one to an audience is either
   * a mistake or an attempt to get marketing out at the authentication rate,
   * which is what gets a number restricted.
   */
  it('refuses an authentication template outright', () => {
    expect(
      templateRefusal({
        ...(usable as object),
        category: TEMPLATE_CATEGORY.AUTHENTICATION,
      } as never),
    ).toContain('cannot be sent as a campaign');
  });

  it('caps the test recipient list', () => {
    expect(MAX_TEST_RECIPIENTS).toBe(10);
  });
});

describe('the stats funnel', () => {
  /**
   * A recipient sits in exactly one status, so counting `status = SENT` alone
   * would make `sentCount` *fall* as messages were delivered — a chart that
   * goes backwards while everything is working.
   */
  it('counts each stage cumulatively', () => {
    expect(FUNNEL.sentCount).toContain(RECIPIENT_STATUS.DELIVERED);
    expect(FUNNEL.sentCount).toContain(RECIPIENT_STATUS.READ);
    expect(FUNNEL.deliveredCount).toContain(RECIPIENT_STATUS.READ);
  });

  /** A reply proves delivery. It does not prove a read receipt was sent. */
  it('treats a reply as delivered but not as read', () => {
    expect(FUNNEL.deliveredCount).toContain(RECIPIENT_STATUS.RESPONDED);
    expect(FUNNEL.readCount).not.toContain(RECIPIENT_STATUS.RESPONDED);
  });

  it('counts failures and skips separately', () => {
    expect(FUNNEL.failedCount).toEqual([RECIPIENT_STATUS.FAILED]);
    expect(FUNNEL.skippedCount).toEqual([RECIPIENT_STATUS.SKIPPED]);
  });

  it('counts every terminal state as having been queued', () => {
    for (const status of [
      RECIPIENT_STATUS.FAILED,
      RECIPIENT_STATUS.SKIPPED,
      RECIPIENT_STATUS.READ,
    ]) {
      expect(FUNNEL.queuedCount).toContain(status);
    }
  });

  it('never counts an excluded or pending recipient as queued', () => {
    expect(FUNNEL.queuedCount).not.toContain(RECIPIENT_STATUS.EXCLUDED);
    expect(FUNNEL.queuedCount).not.toContain(RECIPIENT_STATUS.PENDING);
  });
});

describe('snapshot pacing constants', () => {
  it('leaves API headroom between pages', () => {
    expect(PAGE_DELAY_MS).toBeGreaterThanOrEqual(1_000);
  });

  it('caps the walk above the NFR-S4 target rather than at it', () => {
    expect(MAX_PAGES * 500).toBeGreaterThan(100_000);
  });

  it('exports the failure-window reader the runner uses', () => {
    expect(typeof failureWindowFor).toBe('function');
  });
});
