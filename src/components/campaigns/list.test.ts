import { describe, expect, it } from 'vitest';

import {
  deliveryFunnel,
  matchesCampaignFilter,
  matchesCampaignSearch,
  needsAttention,
  orderCampaigns,
  visibleCampaigns,
} from './list';

const campaign = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'c1',
  name: 'Promoção de Agosto',
  status: 'DRAFT',
  recipientCount: 0,
  sentCount: 0,
  deliveredCount: 0,
  readCount: 0,
  respondedCount: 0,
  failedCount: 0,
  ...over,
});

/**
 * "Needs attention" is the filter an operator lives in, so what it does and
 * does not catch is worth pinning down. Three unrelated situations qualify,
 * and the third — a completed campaign that partly failed — is the one an
 * inbox of green ticks would otherwise hide.
 */
describe('needsAttention', () => {
  it('catches a campaign that broke', () => {
    expect(needsAttention(campaign({ status: 'FAILED' }))).toBe(true);
  });

  it('catches a campaign somebody stopped and never restarted', () => {
    expect(needsAttention(campaign({ status: 'PAUSED' }))).toBe(true);
  });

  /** Built, costed, and waiting on a launch nobody pressed. */
  it('catches a campaign that is ready and unlaunched', () => {
    expect(needsAttention(campaign({ status: 'READY' }))).toBe(true);
  });

  it('catches a finished campaign that did not fully arrive', () => {
    expect(needsAttention(campaign({ status: 'COMPLETED', failedCount: 3 }))).toBe(true);
  });

  it('leaves a clean completed campaign alone', () => {
    expect(needsAttention(campaign({ status: 'COMPLETED', failedCount: 0 }))).toBe(false);
  });

  it('leaves an ordinary draft alone', () => {
    expect(needsAttention(campaign())).toBe(false);
  });
});

describe('matchesCampaignFilter', () => {
  it('groups a snapshotting campaign with the drafts — it is not sending yet', () => {
    expect(matchesCampaignFilter(campaign({ status: 'SNAPSHOTTING' }), 'drafts')).toBe(true);
  });

  it('groups tier-waiting with running — it is mid-send, just paced', () => {
    expect(matchesCampaignFilter(campaign({ status: 'TIER_WAITING' }), 'running')).toBe(true);
  });

  it('groups cancelled with completed — both are over', () => {
    expect(matchesCampaignFilter(campaign({ status: 'CANCELLED' }), 'completed')).toBe(true);
  });

  it('keeps scheduled out of running', () => {
    expect(matchesCampaignFilter(campaign({ status: 'SCHEDULED' }), 'running')).toBe(false);
    expect(matchesCampaignFilter(campaign({ status: 'SCHEDULED' }), 'scheduled')).toBe(true);
  });

  it('lets everything through on all', () => {
    for (const status of ['DRAFT', 'RUNNING', 'FAILED', 'COMPLETED']) {
      expect(matchesCampaignFilter(campaign({ status }), 'all')).toBe(true);
    }
  });
});

describe('matchesCampaignSearch', () => {
  it('matches part of the name, ignoring case', () => {
    expect(matchesCampaignSearch(campaign(), 'AGOSTO')).toBe(true);
  });

  it('keeps everything when the box is empty', () => {
    expect(matchesCampaignSearch(campaign(), '  ')).toBe(true);
  });

  it('answers false for a name that does not contain the query', () => {
    expect(matchesCampaignSearch(campaign(), 'Setembro')).toBe(false);
  });
});

/**
 * The paused campaign is the only row on the screen that needs anybody, and
 * sorting purely by date buries it under this morning's drafts.
 */
describe('orderCampaigns', () => {
  it('lifts running and attention-needing campaigns above the rest', () => {
    const ordered = orderCampaigns([
      campaign({ id: 'draft', status: 'DRAFT' }),
      campaign({ id: 'paused', status: 'PAUSED' }),
      campaign({ id: 'done', status: 'COMPLETED' }),
      campaign({ id: 'live', status: 'RUNNING' }),
    ]);

    expect(ordered.map((row) => row.id)).toEqual(['paused', 'live', 'draft', 'done']);
  });

  it('keeps the server order inside each group', () => {
    const ordered = orderCampaigns([
      campaign({ id: 'newer', status: 'DRAFT' }),
      campaign({ id: 'older', status: 'DRAFT' }),
    ]);

    expect(ordered.map((row) => row.id)).toEqual(['newer', 'older']);
  });
});

describe('visibleCampaigns', () => {
  it('applies the filter and the search together', () => {
    const rows = [
      campaign({ id: 'a', name: 'Agosto', status: 'RUNNING' }),
      campaign({ id: 'b', name: 'Setembro', status: 'RUNNING' }),
      campaign({ id: 'c', name: 'Agosto antigo', status: 'COMPLETED' }),
    ];

    expect(visibleCampaigns(rows, 'running', 'agosto').map((row) => row.id)).toEqual(['a']);
  });

  /**
   * The archive is a different request, not a narrower view of this one. Every
   * row the server sent for it is archived by construction, so the client must
   * not second-guess the field — least of all in the moment after archiving,
   * when the row on screen is stale in exactly that column.
   */
  it('shows everything the archive request returned', () => {
    const rows = [
      campaign({ id: 'a', status: 'COMPLETED', archivedAt: '2026-08-10T00:00:00.000Z' }),
      campaign({ id: 'b', status: 'CANCELLED', archivedAt: null }),
    ];

    expect(visibleCampaigns(rows, 'archived', '').map((row) => row.id)).toEqual(['a', 'b']);
  });

  /**
   * And it keeps the server's order — most recently filed first. Lifting a
   * failed campaign to the top of the archive would argue with the decision to
   * archive it.
   */
  it('does not re-sort the archive by urgency', () => {
    const rows = [
      campaign({ id: 'done', status: 'COMPLETED' }),
      campaign({ id: 'broke', status: 'FAILED' }),
    ];

    expect(visibleCampaigns(rows, 'archived', '').map((row) => row.id)).toEqual([
      'done',
      'broke',
    ]);
    // The live list does the opposite, deliberately.
    expect(visibleCampaigns(rows, 'all', '').map((row) => row.id)).toEqual(['broke', 'done']);
  });

  it('still searches inside the archive', () => {
    const rows = [
      campaign({ id: 'a', name: 'Agosto', status: 'COMPLETED' }),
      campaign({ id: 'b', name: 'Setembro', status: 'COMPLETED' }),
    ];

    expect(visibleCampaigns(rows, 'archived', 'setem').map((row) => row.id)).toEqual(['b']);
  });
});

describe('deliveryFunnel', () => {
  it('measures every stage against the recipient count, not the stage before', () => {
    const funnel = deliveryFunnel(
      campaign({
        recipientCount: 100,
        sentCount: 80,
        deliveredCount: 60,
        readCount: 30,
        respondedCount: 10,
      }),
    );

    expect(funnel.map((stage) => stage.share)).toEqual([1, 0.8, 0.6, 0.3, 0.1]);
  });

  /** A draft has no audience yet, and `0/0` must not reach the width attribute. */
  it('answers zero shares rather than NaN when there are no recipients', () => {
    for (const stage of deliveryFunnel(campaign())) {
      expect(stage.share).toBe(0);
    }
  });

  /**
   * Counters are written by separate workers and a late status can outrun the
   * recipient count for a moment. A bar wider than its track is a rendering
   * bug, so the share is clamped rather than trusted.
   */
  it('clamps a stage that momentarily exceeds the audience', () => {
    const funnel = deliveryFunnel(campaign({ recipientCount: 10, sentCount: 12 }));

    expect(funnel[1].share).toBe(1);
    expect(funnel[1].value).toBe(12);
  });
});
