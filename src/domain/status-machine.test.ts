import { describe, expect, it } from 'vitest';

import { MESSAGE_STATUS, type MessageStatus } from './constants';
import { advanceStatus, fromMetaStatus, isTerminal, recordStatusTimestamp } from './status-machine';

const ALL = Object.values(MESSAGE_STATUS) as MessageStatus[];
const S = MESSAGE_STATUS;

describe('advanceStatus', () => {
  it('never regresses, for any ordered pair', () => {
    const rank: Record<MessageStatus, number> = {
      [S.QUEUED]: 0,
      [S.ACCEPTED]: 1,
      [S.SENT]: 2,
      [S.DELIVERED]: 3,
      [S.READ]: 4,
      [S.PLAYED]: 4,
      [S.FAILED]: 0,
    };

    for (const current of ALL) {
      for (const incoming of ALL) {
        const result = advanceStatus(current, incoming);
        if (result !== S.FAILED && current !== S.FAILED) {
          expect(rank[result]).toBeGreaterThanOrEqual(rank[current]);
        }
      }
    }
  });

  it.each([
    [S.QUEUED, S.ACCEPTED, S.ACCEPTED],
    [S.ACCEPTED, S.SENT, S.SENT],
    [S.SENT, S.DELIVERED, S.DELIVERED],
    [S.DELIVERED, S.READ, S.READ],
  ])('advances %s → %s', (current, incoming, expected) => {
    expect(advanceStatus(current, incoming)).toBe(expected);
  });

  it.each([
    [S.DELIVERED, S.SENT],
    [S.READ, S.DELIVERED],
    [S.READ, S.SENT],
    [S.SENT, S.ACCEPTED],
  ])('ignores a late %s-outranking event (%s)', (current, incoming) => {
    expect(advanceStatus(current, incoming)).toBe(current);
  });

  /**
   * Meta guarantees no ordering, so every permutation of the happy path must
   * converge on the same answer. This is the property that lets the processor
   * handle each status independently, with no queue ordering.
   */
  it('converges to READ for every permutation of sent/delivered/read', () => {
    const permutations = [
      [S.SENT, S.DELIVERED, S.READ],
      [S.SENT, S.READ, S.DELIVERED],
      [S.DELIVERED, S.SENT, S.READ],
      [S.DELIVERED, S.READ, S.SENT],
      [S.READ, S.SENT, S.DELIVERED],
      [S.READ, S.DELIVERED, S.SENT],
    ];

    for (const order of permutations) {
      expect(order.reduce<MessageStatus>(advanceStatus, S.QUEUED)).toBe(S.READ);
    }
  });

  it('absorbs duplicate deliveries without changing state', () => {
    expect([S.SENT, S.SENT, S.SENT].reduce<MessageStatus>(advanceStatus, S.QUEUED)).toBe(S.SENT);
  });

  describe('failure', () => {
    it('is terminal: a later success never resurrects it', () => {
      for (const incoming of ALL) {
        expect(advanceStatus(S.FAILED, incoming)).toBe(S.FAILED);
      }
    });

    it.each([[S.QUEUED], [S.ACCEPTED], [S.SENT]])('overrides %s', (current) => {
      expect(advanceStatus(current, S.FAILED)).toBe(S.FAILED);
    });

    /**
     * Meta emits failures after delivery for post-delivery policy actions. The
     * message *was* delivered; reporting it as failed would tell the rep to
     * resend something the customer already has.
     */
    it.each([[S.DELIVERED], [S.READ], [S.PLAYED]])('does not override %s', (current) => {
      expect(advanceStatus(current, S.FAILED)).toBe(current);
    });
  });

  describe('read and played are peers', () => {
    it('neither downgrades the other', () => {
      expect(advanceStatus(S.READ, S.PLAYED)).toBe(S.READ);
      expect(advanceStatus(S.PLAYED, S.READ)).toBe(S.PLAYED);
    });

    it('both outrank delivered', () => {
      expect(advanceStatus(S.DELIVERED, S.PLAYED)).toBe(S.PLAYED);
      expect(advanceStatus(S.DELIVERED, S.READ)).toBe(S.READ);
    });
  });
});

describe('isTerminal', () => {
  it.each([[S.FAILED], [S.READ], [S.PLAYED]])('%s is terminal', (s) => {
    expect(isTerminal(s)).toBe(true);
  });

  it.each([[S.QUEUED], [S.ACCEPTED], [S.SENT], [S.DELIVERED]])('%s is not terminal', (s) => {
    expect(isTerminal(s)).toBe(false);
  });
});

describe('recordStatusTimestamp', () => {
  it('records every observed transition, even one that does not move the status', () => {
    let ts = recordStatusTimestamp(null, S.DELIVERED, 1786810070);
    ts = recordStatusTimestamp(ts, S.SENT, 1786810069);

    expect(ts).toEqual({ [S.DELIVERED]: 1786810070, [S.SENT]: 1786810069 });
  });

  /** A duplicate webhook must not rewrite when something first happened. */
  it('keeps the first observation of a status', () => {
    const ts = recordStatusTimestamp(
      recordStatusTimestamp(null, S.SENT, 100),
      S.SENT,
      999,
    );
    expect(ts[S.SENT]).toBe(100);
  });

  it('does not mutate its input', () => {
    const original = { [S.SENT]: 100 };
    recordStatusTimestamp(original, S.DELIVERED, 200);
    expect(original).toEqual({ [S.SENT]: 100 });
  });
});

describe('fromMetaStatus', () => {
  it.each([
    ['sent', S.SENT],
    ['delivered', S.DELIVERED],
    ['read', S.READ],
    ['played', S.PLAYED],
    ['failed', S.FAILED],
    ['DELIVERED', S.DELIVERED],
  ])('maps %s → %s', (input, expected) => {
    expect(fromMetaStatus(input)).toBe(expected);
  });

  it.each([['deleted'], ['something_new'], [undefined]])('returns null for %s', (input) => {
    expect(fromMetaStatus(input)).toBeNull();
  });
});
