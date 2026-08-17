import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-62. The campaign counters live on the campaign record and are rebuilt from
 * the recipient rows by a once-a-minute cron, while the detail screen polls
 * every five seconds. So a recipient row marked DELIVERED sat beside a campaign
 * header reading "Running · 0 delivered" for up to a minute — two numbers
 * describing the same event, disagreeing, with nothing on screen to say which
 * one was stale.
 *
 * `reconcileCounters` runs the *same* recount on the way to that screen. The
 * properties worth holding are the ones that make it affordable and safe: it
 * does nothing when nothing changed, it never touches a campaign that cannot
 * change, and it never turns a counting failure into a failed page.
 */

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvDelete = vi.fn();
const countRecipients = vi.fn();
const patchCampaign = vi.fn();

vi.mock('twenty-sdk/logic-function', () => ({
  kv: {
    get: (...args: unknown[]) => kvGet(...args),
    set: (...args: unknown[]) => kvSet(...args),
    delete: (...args: unknown[]) => kvDelete(...args),
  },
}));

vi.mock('twenty-sdk/define', () => ({
  defineLogicFunction: (definition: unknown) => definition,
}));

vi.mock('../server/repositories/campaign-recipients', () => ({
  countRecipients: (...args: unknown[]) => countRecipients(...args),
}));

vi.mock('../server/repositories/campaigns', () => ({
  listCampaignsByStatus: vi.fn(),
  patchCampaign: (...args: unknown[]) => patchCampaign(...args),
}));

vi.mock('../server/repositories/templates', () => ({
  findTemplateById: vi.fn().mockResolvedValue({ category: 'UTILITY' }),
}));

const { reconcileCounters } = await import('./wa-stats-rollup');

const campaign = (over: Record<string, unknown> = {}) => ({
  id: 'camp-1',
  status: 'RUNNING',
  templateId: 'tpl-1',
  startedAt: null,
  ...over,
});

beforeEach(() => {
  for (const spy of [kvGet, kvSet, kvDelete, countRecipients, patchCampaign]) spy.mockReset();

  kvGet.mockResolvedValue({ changed: 1 });
  kvSet.mockResolvedValue(undefined);
  kvDelete.mockResolvedValue(undefined);
  countRecipients.mockResolvedValue(1);
  patchCampaign.mockResolvedValue(undefined);
});

describe('reconciling a campaign’s counters on read', () => {
  it('recounts and returns the campaign the screen should show', async () => {
    const result = await reconcileCounters(campaign());

    expect(patchCampaign).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: 'camp-1', deliveredCount: 1 });
  });

  /** An idle campaign costs one `kv` read per poll and nothing else. */
  it('does nothing when the campaign has not changed', async () => {
    kvGet.mockResolvedValue(null);

    const before = campaign();
    const result = await reconcileCounters(before);

    expect(countRecipients).not.toHaveBeenCalled();
    expect(patchCampaign).not.toHaveBeenCalled();
    expect(result).toBe(before);
  });

  /**
   * A draft has no recipients to count and a cancelled campaign will never
   * gain any, so neither is worth a `kv` read on every poll.
   */
  it.each(['DRAFT', 'READY', 'CANCELLED', 'FAILED'])(
    'leaves a %s campaign alone without asking',
    async (status) => {
      await reconcileCounters(campaign({ status }));

      expect(kvGet).not.toHaveBeenCalled();
      expect(patchCampaign).not.toHaveBeenCalled();
    },
  );

  /**
   * `COMPLETED` is included: the runner sets it while delivery statuses are
   * still arriving from Meta, so the final numbers land minutes after the
   * campaign stops sending.
   */
  it('still recounts a completed campaign', async () => {
    await reconcileCounters(campaign({ status: 'COMPLETED' }));

    expect(patchCampaign).toHaveBeenCalledTimes(1);
  });

  /** Stale numbers beat no screen: a failed recount is not a failed page. */
  it('returns the campaign unchanged when the recount fails', async () => {
    countRecipients.mockRejectedValue(new Error('aggregate unavailable'));

    const before = campaign();

    await expect(reconcileCounters(before)).resolves.toBe(before);
    expect(patchCampaign).not.toHaveBeenCalled();
  });

  /**
   * Cleared only if nothing arrived while the recount was running — the same
   * rule the cron follows (D-39). Clearing unconditionally would lose a status
   * that landed mid-recount.
   */
  it('clears the hint it read, conditionally', async () => {
    await reconcileCounters(campaign());

    expect(kvDelete).toHaveBeenCalled();
  });
});
