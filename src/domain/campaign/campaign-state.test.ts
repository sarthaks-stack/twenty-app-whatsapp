import { describe, expect, it } from 'vitest';

import { CAMPAIGN_STATUS, MESSAGING_TIER, TEMPLATE_CATEGORY } from '../constants';
import {
  MAX_MANUAL_PERSON_IDS,
  describeAudience,
  parseAudienceDefinition,
  parseCursor,
} from './audience';
import { isBusinessInitiated } from './tier-budget';
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  isActive,
  isTerminal,
} from './transitions';

describe('the campaign state machine', () => {
  it('refuses a transition that is not on the table', () => {
    expect(canTransition(CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.RUNNING)).toEqual({
      ok: false,
      reason: 'DRAFT cannot become RUNNING',
    });
  });

  it('allows the ordinary build-and-launch path', () => {
    expect(canTransition(CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.SNAPSHOTTING).ok).toBe(true);
    expect(canTransition(CAMPAIGN_STATUS.SNAPSHOTTING, CAMPAIGN_STATUS.READY).ok).toBe(true);
    expect(canTransition(CAMPAIGN_STATUS.READY, CAMPAIGN_STATUS.SCHEDULED).ok).toBe(true);
    expect(canTransition(CAMPAIGN_STATUS.SCHEDULED, CAMPAIGN_STATUS.RUNNING).ok).toBe(true);
  });

  /**
   * FR-CAM-8 asks for idempotent controls. Repeating `pause` on a paused
   * campaign is a no-op, not a 409 — the alternative is every caller checking
   * first, and the one that forgets is the one an operator meets.
   */
  it('treats a transition to the current state as a no-op', () => {
    expect(canTransition(CAMPAIGN_STATUS.PAUSED, CAMPAIGN_STATUS.PAUSED)).toEqual({
      ok: true,
      noop: true,
    });
  });

  it('lets nothing leave a terminal state', () => {
    for (const terminal of [CAMPAIGN_STATUS.COMPLETED, CAMPAIGN_STATUS.CANCELLED]) {
      expect(canTransition(terminal, CAMPAIGN_STATUS.RUNNING).ok).toBe(false);
      expect(ALLOWED_TRANSITIONS[terminal]).toEqual([]);
      expect(isTerminal(terminal)).toBe(true);
    }
  });

  /** A failure is recoverable, but by a human — never by the next tick. */
  it('lets a failed campaign recover only to paused', () => {
    expect(canTransition(CAMPAIGN_STATUS.FAILED, CAMPAIGN_STATUS.PAUSED).ok).toBe(true);
    expect(canTransition(CAMPAIGN_STATUS.FAILED, CAMPAIGN_STATUS.RUNNING).ok).toBe(false);
  });

  /**
   * Resuming a paused campaign means running it now. Putting it back behind a
   * `scheduledAt` that has already passed would be a resume that never resumes.
   */
  it('does not send a paused campaign back to scheduled', () => {
    expect(canTransition(CAMPAIGN_STATUS.PAUSED, CAMPAIGN_STATUS.SCHEDULED).ok).toBe(false);
  });

  it('counts only running and tier_waiting as active', () => {
    expect(isActive(CAMPAIGN_STATUS.RUNNING)).toBe(true);
    expect(isActive(CAMPAIGN_STATUS.TIER_WAITING)).toBe(true);
    expect(isActive(CAMPAIGN_STATUS.PAUSED)).toBe(false);
    expect(isActive(CAMPAIGN_STATUS.FAILED)).toBe(false);
  });

  it('names every status in the table', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual(
      Object.values(CAMPAIGN_STATUS).sort(),
    );
  });
});

describe('audience definitions', () => {
  it('accepts a view', () => {
    const parsed = parseAudienceDefinition({ kind: 'view', viewId: 'v1' });

    expect(parsed.ok && parsed.definition.kind).toBe('view');
  });

  it('rejects a view with no id', () => {
    expect(parseAudienceDefinition({ kind: 'view' })).toEqual({
      ok: false,
      error: 'a view audience needs viewId',
    });
  });

  it('de-duplicates a manual list', () => {
    const parsed = parseAudienceDefinition({
      kind: 'manual',
      personIds: ['a', 'b', 'a'],
    });

    expect(parsed.ok && parsed.definition.kind === 'manual' && parsed.definition.personIds).toEqual([
      'a',
      'b',
    ]);
  });

  /**
   * An empty audience is refused rather than accepted as "nobody": zero
   * recipients looks exactly like a filter that excluded everyone, and the two
   * want opposite responses from the admin.
   */
  it('refuses an empty manual list', () => {
    expect(parseAudienceDefinition({ kind: 'manual', personIds: [] }).ok).toBe(false);
  });

  it('refuses a manual list larger than the column should carry', () => {
    const personIds = Array.from({ length: MAX_MANUAL_PERSON_IDS + 1 }, (_v, i) => `p${i}`);

    expect(parseAudienceDefinition({ kind: 'manual', personIds }).ok).toBe(false);
  });

  it('refuses an unknown kind', () => {
    expect(parseAudienceDefinition({ kind: 'sql' }).ok).toBe(false);
  });

  it('stamps capturedAt when the caller did not', () => {
    const now = new Date('2026-08-16T09:00:00.000Z');
    const parsed = parseAudienceDefinition({ kind: 'view', viewId: 'v1' }, { now });

    expect(parsed.ok && parsed.definition.capturedAt).toBe(now.toISOString());
  });

  it('describes each kind for the audit line', () => {
    expect(
      describeAudience({ kind: 'manual', personIds: ['a', 'b'], capturedAt: 'x' }),
    ).toBe('2 manually selected people');
  });
});

describe('audience cursors', () => {
  it('round-trips a relay cursor', () => {
    expect(parseCursor({ kind: 'relay', after: 'abc' })).toEqual({
      kind: 'relay',
      after: 'abc',
    });
  });

  it('round-trips an offset cursor', () => {
    expect(parseCursor({ kind: 'offset', at: 500 })).toEqual({ kind: 'offset', at: 500 });
  });

  it('rejects anything else, so a bad resume restarts rather than skips', () => {
    expect(parseCursor({ kind: 'relay' })).toBeNull();
    expect(parseCursor('500')).toBeNull();
    expect(parseCursor(null)).toBeNull();
  });
});

describe('what consumes tier allowance', () => {
  /** A reply inside the window is free — and is what the reserve protects. */
  it('does not count a free-form reply', () => {
    expect(isBusinessInitiated({ isTemplate: false, windowOpen: true })).toBe(false);
    expect(isBusinessInitiated({ isTemplate: false, windowOpen: false })).toBe(false);
  });

  it('counts a template sent outside the window', () => {
    expect(
      isBusinessInitiated({
        isTemplate: true,
        templateCategory: TEMPLATE_CATEGORY.UTILITY,
        windowOpen: false,
      }),
    ).toBe(true);
  });

  it('does not count a utility template inside an open window', () => {
    expect(
      isBusinessInitiated({
        isTemplate: true,
        templateCategory: TEMPLATE_CATEGORY.UTILITY,
        windowOpen: true,
      }),
    ).toBe(false);
  });

  /**
   * Marketing is business-initiated by definition — even to someone who wrote
   * in five minutes ago, because the business chose to send it.
   */
  it('counts a marketing template even inside an open window', () => {
    expect(
      isBusinessInitiated({
        isTemplate: true,
        templateCategory: TEMPLATE_CATEGORY.MARKETING,
        windowOpen: true,
      }),
    ).toBe(true);
  });
});

describe('the tier limits table', () => {
  it('names every tier', async () => {
    const { TIER_LIMITS } = await import('./tier-budget');

    expect(Object.keys(TIER_LIMITS).sort()).toEqual(Object.values(MESSAGING_TIER).sort());
  });
});
