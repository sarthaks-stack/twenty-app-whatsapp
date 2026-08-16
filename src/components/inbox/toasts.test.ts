import { describe, expect, it } from 'vitest';

import type { ThreadProjection } from '../../domain/feed/projection';
import { decideToasts, MAX_TOASTS_PER_TICK } from './use-inbound-toasts';

const thread = (overrides: Partial<ThreadProjection>): ThreadProjection =>
  ({
    id: 't1',
    waId: '244900000001',
    profileName: 'Ana',
    dialablePhone: '+244900000001',
    status: 'OPEN',
    windowState: 'OPEN',
    windowKind: 'STANDARD',
    serviceWindowExpiresAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    lastMessageDirection: null,
    unreadCount: 0,
    isBlocked: false,
    originCampaignId: null,
    accountId: 'a1',
    personId: null,
    assigneeId: 'wm-1',
    linkCandidates: null,
    referral: null,
    person: null,
    ...overrides,
  }) as ThreadProjection;

/**
 * D-10 layer 2.
 *
 * The rule worth defending is the one about the *first* tick. A toaster that
 * treats every thread it has never seen as news fires once per conversation the
 * moment someone opens the page — forty snackbars for messages that arrived
 * yesterday. That is not a notification system, it is a reason to close the tab.
 */
describe('decideToasts', () => {
  it('says nothing at all on the first sight of a page full of conversations', () => {
    const seen = new Map<string, string>();
    const threads = Array.from({ length: 40 }, (_, index) =>
      thread({ id: `t${index}`, lastInboundAt: '2026-08-16T10:00:00.000Z' }),
    );

    expect(decideToasts(threads, seen, { seeded: false })).toEqual([]);
    // …but it remembers, so the next arrival is news.
    expect(seen.size).toBe(40);
  });

  it('toasts a conversation whose newest inbound message moved forward', () => {
    const seen = new Map([['t1', '2026-08-16T10:00:00.000Z']]);

    expect(
      decideToasts([thread({ lastInboundAt: '2026-08-16T10:05:00.000Z' })], seen, {
        seeded: true,
      }),
    ).toEqual([{ threadId: 't1', name: 'Ana' }]);
  });

  it('says nothing when the same timestamp comes back, which is every poll', () => {
    const seen = new Map([['t1', '2026-08-16T10:00:00.000Z']]);

    expect(
      decideToasts([thread({ lastInboundAt: '2026-08-16T10:00:00.000Z' })], seen, {
        seeded: true,
      }),
    ).toEqual([]);
  });

  it('toasts a conversation it has never seen once it is seeded', () => {
    const seen = new Map([['t1', '2026-08-16T10:00:00.000Z']]);

    const decisions = decideToasts(
      [thread({ id: 't2', profileName: 'Bruno', lastInboundAt: '2026-08-16T10:01:00.000Z' })],
      seen,
      { seeded: true },
    );

    expect(decisions).toEqual([{ threadId: 't2', name: 'Bruno' }]);
  });

  it('ignores a conversation that has never received anything', () => {
    const seen = new Map<string, string>();

    expect(decideToasts([thread({ lastInboundAt: null })], seen, { seeded: true })).toEqual([]);
    expect(seen.size).toBe(0);
  });

  it('collapses a burst into one count rather than a wall of snackbars', () => {
    const seen = new Map<string, string>();
    const threads = Array.from({ length: MAX_TOASTS_PER_TICK + 8 }, (_, index) =>
      thread({ id: `t${index}`, lastInboundAt: '2026-08-16T10:00:00.000Z' }),
    );

    expect(decideToasts(threads, seen, { seeded: true })).toEqual([
      { count: MAX_TOASTS_PER_TICK + 8 },
    ]);
  });

  it('names the number when there is no profile name to use', () => {
    const seen = new Map<string, string>();

    expect(
      decideToasts(
        [thread({ profileName: null, lastInboundAt: '2026-08-16T10:00:00.000Z' })],
        seen,
        { seeded: true },
      ),
    ).toEqual([{ threadId: 't1', name: '+244900000001' }]);
  });

  it('prefers the linked contact’s name over the WhatsApp profile name', () => {
    const seen = new Map<string, string>();

    const decisions = decideToasts(
      [
        thread({
          profileName: null,
          lastInboundAt: '2026-08-16T10:00:00.000Z',
          person: {
            id: 'p1',
            firstName: 'Ana',
            lastName: 'Silva',
            jobTitle: null,
            city: null,
            primaryEmail: null,
            primaryPhone: null,
            whatsappOptInStatus: null,
            whatsappOptInUpdatedAt: null,
            companyId: null,
          },
        }),
      ],
      seen,
      { seeded: true },
    );

    expect(decisions).toEqual([{ threadId: 't1', name: 'Ana Silva' }]);
  });
});
