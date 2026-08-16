import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rollup hint (D-39).
 *
 * A recount takes several round trips, and a delivery status landing in the
 * middle of one writes a delta the recount did not see. Clearing the hint
 * unconditionally threw that away, so a campaign's numbers stayed one event
 * behind until something else moved them — and for the last delivery of a
 * finished campaign, nothing else ever does.
 */

const store = new Map<string, unknown>();

vi.mock('twenty-sdk/logic-function', () => ({
  kv: {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: unknown) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  },
}));

const {
  campaignDeltaKey,
  clearCampaignChangeIfUnchanged,
  deltaFingerprint,
  noteCampaignChange,
  readCampaignChange,
} = await import('./campaign-deltas');

beforeEach(() => {
  store.clear();
});

describe('accumulating a hint', () => {
  it('adds counts for the same field', async () => {
    await noteCampaignChange('c1', { sentCount: 1 });
    await noteCampaignChange('c1', { sentCount: 2, failedCount: 1 });

    expect(await readCampaignChange('c1')).toEqual({ sentCount: 3, failedCount: 1 });
  });

  it('keeps campaigns apart', async () => {
    await noteCampaignChange('c1', { sentCount: 1 });
    await noteCampaignChange('c2', { sentCount: 5 });

    expect(await readCampaignChange('c2')).toEqual({ sentCount: 5 });
  });
});

describe('clearing it', () => {
  it('clears when nothing arrived during the recount', async () => {
    await noteCampaignChange('c1', { sentCount: 1 });

    const seen = await readCampaignChange('c1');

    expect(await clearCampaignChangeIfUnchanged('c1', seen)).toBe(true);
    expect(await readCampaignChange('c1')).toBeNull();
  });

  it('keeps a hint that grew while the recount was running', async () => {
    await noteCampaignChange('c1', { sentCount: 1 });

    const seen = await readCampaignChange('c1');

    // A delivery status lands mid-recount.
    await noteCampaignChange('c1', { deliveredCount: 1 });

    expect(await clearCampaignChangeIfUnchanged('c1', seen)).toBe(false);
    expect(await readCampaignChange('c1')).toEqual({ sentCount: 1, deliveredCount: 1 });
  });

  it('does not care about key order', () => {
    expect(deltaFingerprint({ a: 1, b: 2 })).toBe(deltaFingerprint({ b: 2, a: 1 }));
    expect(deltaFingerprint({ a: 1 })).not.toBe(deltaFingerprint({ a: 2 }));
    expect(deltaFingerprint(null)).toBe('');
  });

  it('writes under a key scoped to the campaign', () => {
    expect(campaignDeltaKey('c1')).toContain('c1');
  });
});
