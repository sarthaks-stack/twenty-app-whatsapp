import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_STATUS,
  CONSENT_STATUS,
  LANE,
  QUALITY,
  TEMPLATE_CATEGORY,
  TEMPLATE_STATUS,
  WINDOW_KIND,
  WINDOW_STATE,
} from '../constants';
import {
  computeWindowExpiry,
  isWindowExpiringSoon,
  isWindowOpen,
  windowRemainingMs,
  windowStateFor,
} from './service-window';
import { DENIAL, WARNING, evaluateSendPermission, type SendContext, type SendIntent } from './send-permission';

const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;

describe('computeWindowExpiry', () => {
  it('opens 24 hours for an ordinary inbound message', () => {
    expect(computeWindowExpiry(at('2026-08-15T10:00:00Z'), WINDOW_KIND.STANDARD)).toEqual(
      at('2026-08-16T10:00:00Z'),
    );
  });

  it('opens 72 hours for a Click-to-WhatsApp conversation', () => {
    expect(computeWindowExpiry(at('2026-08-15T10:00:00Z'), WINDOW_KIND.FREE_ENTRY_POINT)).toEqual(
      at('2026-08-18T10:00:00Z'),
    );
  });

  it('honours a configured window length', () => {
    expect(
      computeWindowExpiry(at('2026-08-15T10:00:00Z'), WINDOW_KIND.STANDARD, {
        serviceWindowHours: 1,
        fepWindowHours: 72,
      }),
    ).toEqual(at('2026-08-15T11:00:00Z'));
  });

  /**
   * The arithmetic is UTC epoch milliseconds throughout, so a DST transition in
   * the observer's timezone must change nothing. Asserting the *absence* of an
   * effect is the point: a naive local-time implementation shifts by an hour
   * here and silently gives every European contact a 23- or 25-hour window.
   */
  it('is unaffected by a DST transition', () => {
    // Europe/Lisbon springs forward 2026-03-29 01:00 UTC.
    expect(computeWindowExpiry(at('2026-03-28T23:30:00Z'), WINDOW_KIND.STANDARD)).toEqual(
      at('2026-03-29T23:30:00Z'),
    );
  });
});

describe('isWindowOpen', () => {
  const expiry = at('2026-08-16T10:00:00Z');

  it.each([
    ['one ms before expiry', new Date(expiry.getTime() - 1), true],
    ['exactly at expiry', expiry, false],
    ['one ms after expiry', new Date(expiry.getTime() + 1), false],
  ])('%s → %s', (_label, now, expected) => {
    expect(isWindowOpen(expiry, now)).toBe(expected);
  });

  it.each([[null], [undefined]])('treats %s expiry as closed', (value) => {
    expect(isWindowOpen(value, at('2026-08-15T10:00:00Z'))).toBe(false);
  });
});

describe('window helpers', () => {
  it('derives the denormalised state', () => {
    const now = at('2026-08-15T10:00:00Z');
    expect(windowStateFor(at('2026-08-15T11:00:00Z'), now)).toBe(WINDOW_STATE.OPEN);
    expect(windowStateFor(at('2026-08-15T09:00:00Z'), now)).toBe(WINDOW_STATE.EXPIRED);
  });

  it('clamps remaining time at zero rather than going negative', () => {
    expect(windowRemainingMs(at('2026-08-15T09:00:00Z'), at('2026-08-15T10:00:00Z'))).toBe(0);
  });

  it('warns only inside the threshold, and not once expired', () => {
    const now = at('2026-08-15T10:00:00Z');
    expect(isWindowExpiringSoon(new Date(now.getTime() + 30 * 60_000), now)).toBe(true);
    expect(isWindowExpiringSoon(new Date(now.getTime() + 2 * HOUR), now)).toBe(false);
    expect(isWindowExpiringSoon(new Date(now.getTime() - 1), now)).toBe(false);
  });
});

// ─── the gate ────────────────────────────────────────────────────────────────

const NOW = at('2026-08-15T10:00:00Z');
const OPEN = at('2026-08-15T20:00:00Z');
const CLOSED = at('2026-08-15T09:00:00Z');

const context = (overrides: Partial<SendContext> = {}): SendContext => ({
  now: NOW,
  thread: { serviceWindowExpiresAt: OPEN, isBlocked: false },
  person: { whatsappOptInStatus: CONSENT_STATUS.OPTED_IN },
  account: { status: ACCOUNT_STATUS.CONNECTED, qualityRating: QUALITY.GREEN },
  template: {
    status: TEMPLATE_STATUS.APPROVED,
    publishedToCrm: true,
    isUsableInCrm: true,
  },
  ...overrides,
});

const freeform: SendIntent = { kind: 'FREEFORM', lane: LANE.INTERACTIVE };
const utilityTemplate: SendIntent = {
  kind: 'TEMPLATE',
  templateCategory: TEMPLATE_CATEGORY.UTILITY,
  lane: LANE.INTERACTIVE,
};
const marketingCampaign: SendIntent = {
  kind: 'TEMPLATE',
  templateCategory: TEMPLATE_CATEGORY.MARKETING,
  lane: LANE.CAMPAIGN,
};

describe('evaluateSendPermission', () => {
  it('allows a free-form reply inside an open window', () => {
    expect(evaluateSendPermission(freeform, context())).toEqual({ allowed: true, warnings: [] });
  });

  it('denies free-form once the window has closed', () => {
    const verdict = evaluateSendPermission(
      freeform,
      context({ thread: { serviceWindowExpiresAt: CLOSED, isBlocked: false } }),
    );
    expect(verdict).toMatchObject({ allowed: false, reason: DENIAL.WINDOW_CLOSED });
  });

  /** FR-OUT-5: a template is always available from the same thread. */
  it('allows a template when the window has closed', () => {
    expect(
      evaluateSendPermission(
        utilityTemplate,
        context({ thread: { serviceWindowExpiresAt: CLOSED, isBlocked: false } }),
      ).allowed,
    ).toBe(true);
  });

  it('denies everything when the account is not connected', () => {
    for (const intent of [freeform, utilityTemplate, marketingCampaign]) {
      expect(
        evaluateSendPermission(
          intent,
          context({ account: { status: ACCOUNT_STATUS.ERROR, qualityRating: QUALITY.GREEN } }),
        ),
      ).toMatchObject({ reason: DENIAL.ACCOUNT_NOT_CONNECTED });
    }
  });

  it('denies a blocked thread', () => {
    expect(
      evaluateSendPermission(
        freeform,
        context({ thread: { serviceWindowExpiresAt: OPEN, isBlocked: true } }),
      ),
    ).toMatchObject({ reason: DENIAL.THREAD_BLOCKED });
  });

  describe('consent (FR-CON-2, SEC-6)', () => {
    const optedOut = { person: { whatsappOptInStatus: CONSENT_STATUS.OPTED_OUT } };

    it('hard-blocks a business-initiated template to an opted-out contact', () => {
      expect(evaluateSendPermission(utilityTemplate, context(optedOut))).toMatchObject({
        reason: DENIAL.OPTED_OUT,
      });
    });

    /**
     * The customer wrote to us. Refusing to answer is neither helpful nor what
     * opting out of marketing means.
     */
    it('still allows a free-form reply inside an open window', () => {
      expect(evaluateSendPermission(freeform, context(optedOut)).allowed).toBe(true);
    });

    it('blocks free-form to an opted-out contact once the window closes', () => {
      expect(
        evaluateSendPermission(
          freeform,
          context({ ...optedOut, thread: { serviceWindowExpiresAt: CLOSED, isBlocked: false } }),
        ),
      ).toMatchObject({ reason: DENIAL.OPTED_OUT });
    });

    it('excludes an unknown-consent contact from a marketing campaign', () => {
      expect(
        evaluateSendPermission(
          marketingCampaign,
          context({ person: { whatsappOptInStatus: CONSENT_STATUS.UNKNOWN } }),
        ),
      ).toMatchObject({ reason: DENIAL.NO_CONSENT });
    });

    /** A rep sending one template to one contact is a judgement call, not a blast. */
    it('only warns for a 1:1 marketing template to an unknown-consent contact', () => {
      const verdict = evaluateSendPermission(
        { kind: 'TEMPLATE', templateCategory: TEMPLATE_CATEGORY.MARKETING, lane: LANE.INTERACTIVE },
        context({ person: { whatsappOptInStatus: CONSENT_STATUS.UNKNOWN } }),
      );
      expect(verdict.allowed).toBe(true);
      expect(verdict.warnings).toContain(WARNING.CONSENT_UNKNOWN_MARKETING);
    });

    it('allows a utility campaign to an unknown-consent contact', () => {
      expect(
        evaluateSendPermission(
          { kind: 'TEMPLATE', templateCategory: TEMPLATE_CATEGORY.UTILITY, lane: LANE.CAMPAIGN },
          context({ person: { whatsappOptInStatus: CONSENT_STATUS.UNKNOWN } }),
        ).allowed,
      ).toBe(true);
    });

    it('treats a missing person as unknown consent', () => {
      expect(evaluateSendPermission(marketingCampaign, context({ person: null }))).toMatchObject({
        reason: DENIAL.NO_CONSENT,
      });
    });
  });

  describe('precedence', () => {
    /**
     * Consent precedes the window: an opted-out contact with a closed window
     * must report OPTED_OUT, because offering the template picker — the remedy
     * for WINDOW_CLOSED — would be exactly the wrong next step.
     */
    it('reports opt-out ahead of a closed window', () => {
      expect(
        evaluateSendPermission(
          freeform,
          context({
            person: { whatsappOptInStatus: CONSENT_STATUS.OPTED_OUT },
            thread: { serviceWindowExpiresAt: CLOSED, isBlocked: false },
          }),
        ),
      ).toMatchObject({ reason: DENIAL.OPTED_OUT });
    });

    it('reports a disconnected account ahead of everything else', () => {
      expect(
        evaluateSendPermission(
          freeform,
          context({
            account: { status: ACCOUNT_STATUS.ERROR, qualityRating: QUALITY.RED },
            thread: { serviceWindowExpiresAt: CLOSED, isBlocked: true },
            person: { whatsappOptInStatus: CONSENT_STATUS.OPTED_OUT },
          }),
        ),
      ).toMatchObject({ reason: DENIAL.ACCOUNT_NOT_CONNECTED });
    });
  });

  describe('template state (FR-TPL-2, FR-TPL-4)', () => {
    it.each([
      ['not approved', { status: TEMPLATE_STATUS.PENDING, publishedToCrm: true, isUsableInCrm: true }],
      ['not published', { status: TEMPLATE_STATUS.APPROVED, publishedToCrm: false, isUsableInCrm: true }],
      ['unsupported components', { status: TEMPLATE_STATUS.APPROVED, publishedToCrm: true, isUsableInCrm: false }],
      ['paused by Meta', { status: TEMPLATE_STATUS.PAUSED, publishedToCrm: true, isUsableInCrm: true }],
    ])('denies a template that is %s', (_label, template) => {
      expect(evaluateSendPermission(utilityTemplate, context({ template }))).toMatchObject({
        reason: DENIAL.TEMPLATE_UNAVAILABLE,
      });
    });

    it('denies a template send with no template supplied', () => {
      expect(evaluateSendPermission(utilityTemplate, context({ template: undefined }))).toMatchObject({
        reason: DENIAL.TEMPLATE_UNAVAILABLE,
      });
    });
  });

  describe('quality (FR-CAM-6)', () => {
    const red = { account: { status: ACCOUNT_STATUS.CONNECTED, qualityRating: QUALITY.RED } };

    it('blocks a campaign send on a RED number', () => {
      expect(evaluateSendPermission(marketingCampaign, context({ ...red, person: { whatsappOptInStatus: CONSENT_STATUS.OPTED_IN } }))).toMatchObject({
        reason: DENIAL.QUALITY_RED,
      });
    });

    /** Reps must still be able to answer customers on a degraded number. */
    it('never blocks an interactive send on a RED number', () => {
      expect(evaluateSendPermission(freeform, context(red)).allowed).toBe(true);
      expect(evaluateSendPermission(utilityTemplate, context(red)).allowed).toBe(true);
    });

    it('warns but allows on YELLOW', () => {
      const verdict = evaluateSendPermission(
        marketingCampaign,
        context({ account: { status: ACCOUNT_STATUS.CONNECTED, qualityRating: QUALITY.YELLOW } }),
      );
      expect(verdict.allowed).toBe(true);
      expect(verdict.warnings).toContain(WARNING.QUALITY_YELLOW);
    });
  });

  it('reports warnings alongside a denial, not instead of it', () => {
    const verdict = evaluateSendPermission(
      freeform,
      context({
        thread: { serviceWindowExpiresAt: CLOSED, isBlocked: false },
        account: { status: ACCOUNT_STATUS.CONNECTED, qualityRating: QUALITY.YELLOW },
      }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.warnings).toContain(WARNING.QUALITY_YELLOW);
  });
});
