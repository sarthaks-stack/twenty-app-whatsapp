import { describe, expect, it } from 'vitest';

import { LANE } from './constants';
import {
  backoffDelayMs,
  computeSlots,
  delayForSlot,
  laneRate,
  recipientSpacingDelayMs,
} from './pacing';

const NOW = 1_786_800_000_000;

describe('laneRate', () => {
  it('splits the throttle between the two lanes', () => {
    expect(laneRate(LANE.INTERACTIVE)).toBe(8); // 20 × 0.4
    expect(laneRate(LANE.CAMPAIGN)).toBe(12); // 20 × 0.6
  });

  it('never paces interactive below the floor, however small the share', () => {
    expect(laneRate(LANE.INTERACTIVE, { throttlePerSecond: 2, interactiveShare: 0.4 })).toBe(5);
  });

  it('keeps the campaign lane above zero', () => {
    expect(laneRate(LANE.CAMPAIGN, { throttlePerSecond: 1, interactiveShare: 1 })).toBe(1);
  });

  it('the two lanes never exceed the configured ceiling', () => {
    const rates = { throttlePerSecond: 20, interactiveShare: 0.4, minimumInteractivePerSecond: 0 };
    expect(laneRate(LANE.INTERACTIVE, rates) + laneRate(LANE.CAMPAIGN, rates)).toBeLessThanOrEqual(
      rates.throttlePerSecond,
    );
  });
});

describe('computeSlots', () => {
  it('spaces sends evenly at the lane rate', () => {
    const { slots } = computeSlots({ cursorAt: null, now: NOW, count: 4, ratePerSecond: 10 });
    expect(slots).toEqual([NOW, NOW + 100, NOW + 200, NOW + 300]);
  });

  it('advances the cursor past the last slot, so the next batch cannot overlap', () => {
    const { nextCursorAt } = computeSlots({ cursorAt: null, now: NOW, count: 4, ratePerSecond: 10 });
    expect(nextCursorAt).toBe(NOW + 400);
  });

  /** A quiet period must not licence a burst. */
  it('clamps a cursor left in the past to now', () => {
    const { slots } = computeSlots({
      cursorAt: NOW - 60_000,
      now: NOW,
      count: 2,
      ratePerSecond: 10,
    });
    expect(slots[0]).toBe(NOW);
  });

  it('respects a cursor already in the future rather than jumping it', () => {
    const future = NOW + 5_000;
    const { slots } = computeSlots({ cursorAt: future, now: NOW, count: 2, ratePerSecond: 10 });
    expect(slots[0]).toBe(future);
  });

  it('is continuous across consecutive batches', () => {
    const first = computeSlots({ cursorAt: null, now: NOW, count: 3, ratePerSecond: 10 });
    const second = computeSlots({
      cursorAt: first.nextCursorAt,
      now: NOW,
      count: 3,
      ratePerSecond: 10,
    });
    const all = [...first.slots, ...second.slots];

    for (let i = 1; i < all.length; i += 1) {
      expect(all[i] - all[i - 1]).toBe(100);
    }
  });

  it('handles an empty batch without moving the cursor backwards', () => {
    expect(computeSlots({ cursorAt: NOW + 1000, now: NOW, count: 0, ratePerSecond: 10 })).toEqual({
      slots: [],
      nextCursorAt: NOW + 1000,
    });
  });

  it('rejects a non-positive rate rather than dividing by zero', () => {
    expect(() => computeSlots({ cursorAt: null, now: NOW, count: 1, ratePerSecond: 0 })).toThrow();
  });

  /**
   * The property that makes NFR-S5 structural: a campaign saturating its lane
   * for an hour cannot delay an interactive send, because the lanes never share
   * a cursor.
   */
  it('leaves the interactive lane unaffected by a saturated campaign lane', () => {
    const campaign = computeSlots({
      cursorAt: null,
      now: NOW,
      count: 10_000,
      ratePerSecond: laneRate(LANE.CAMPAIGN),
    });
    expect(campaign.nextCursorAt).toBeGreaterThan(NOW + 600_000);

    const interactive = computeSlots({
      cursorAt: null,
      now: NOW,
      count: 1,
      ratePerSecond: laneRate(LANE.INTERACTIVE),
    });
    expect(interactive.slots[0]).toBe(NOW);
  });
});

describe('delayForSlot', () => {
  it('is zero for a slot in the past', () => {
    expect(delayForSlot(NOW - 5_000, NOW)).toBe(0);
  });

  it('is the remaining time for a future slot', () => {
    expect(delayForSlot(NOW + 250, NOW)).toBe(250);
  });
});

describe('recipientSpacingDelayMs', () => {
  it('allows a send when nothing was sent recently', () => {
    expect(recipientSpacingDelayMs({ lastOutboundAt: null, now: NOW, minimumSpacingMs: 250 })).toBe(0);
  });

  it('returns the remaining gap when a send is too soon', () => {
    expect(
      recipientSpacingDelayMs({
        lastOutboundAt: new Date(NOW - 100),
        now: NOW,
        minimumSpacingMs: 250,
      }),
    ).toBe(150);
  });

  it('allows a send exactly at the spacing boundary', () => {
    expect(
      recipientSpacingDelayMs({
        lastOutboundAt: new Date(NOW - 250),
        now: NOW,
        minimumSpacingMs: 250,
      }),
    ).toBe(0);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially with the attempt', () => {
    const full = () => 1;
    expect(backoffDelayMs(0, full)).toBe(2000);
    expect(backoffDelayMs(1, full)).toBe(4000);
    expect(backoffDelayMs(2, full)).toBe(8000);
  });

  it('applies full jitter, so retries do not synchronise into a thundering herd', () => {
    expect(backoffDelayMs(2, () => 0)).toBe(0);
    expect(backoffDelayMs(2, () => 0.5)).toBe(4000);
  });

  it('returns null once attempts are exhausted, signalling a terminal failure', () => {
    expect(backoffDelayMs(5, () => 1)).toBeNull();
    expect(backoffDelayMs(6, () => 1)).toBeNull();
  });
});
