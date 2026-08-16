import { kv } from 'twenty-sdk/logic-function';

import { describeError, logger } from './logger';

/**
 * "Something about this campaign changed" (specs/03 §5.2, specs/07 §10).
 *
 * A note in `kv`, written by whatever advanced a recipient — a delivery status,
 * a reply — and read by `wa-stats-rollup` to decide which campaigns are worth
 * recounting. An idle campaign then costs one `kv` read per tick instead of
 * seven aggregate queries, which is what makes a 30-second freshness target
 * affordable at campaign scale.
 *
 * It is deliberately **not** the source of the counts. `kv` has no
 * compare-and-swap, so an increment lost under concurrency would be a number
 * that stays wrong for the life of the campaign. Losing a *hint* costs one tick
 * of latency, and the next status webhook writes another.
 */

export const campaignDeltaKey = (campaignId: string): string =>
  `wa:campaign-delta:${campaignId}`;

export const noteCampaignChange = async (
  campaignId: string,
  delta: Record<string, number> = { changed: 1 },
): Promise<void> => {
  try {
    const key = campaignDeltaKey(campaignId);
    const current = (await kv.get<Record<string, number>>(key, { scope: 'WORKSPACE' })) ?? {};

    const merged = { ...current };

    for (const [field, value] of Object.entries(delta)) {
      merged[field] = (merged[field] ?? 0) + value;
    }

    await kv.set(key, merged, { scope: 'WORKSPACE' });
  } catch (error) {
    logger.debug('wa.campaign.delta_write_failed', { campaignId, ...describeError(error) });
  }
};

export const readCampaignChange = async (
  campaignId: string,
): Promise<Record<string, number> | null> => {
  try {
    return await kv.get<Record<string, number>>(campaignDeltaKey(campaignId), {
      scope: 'WORKSPACE',
    });
  } catch (error) {
    /**
     * An unreadable hint must never freeze the numbers, so the caller is told
     * to recount. Being wrong costs a handful of aggregate reads.
     */
    logger.debug('wa.campaign.delta_read_failed', { campaignId, ...describeError(error) });

    return { unreadable: 1 };
  }
};

export const clearCampaignChange = async (campaignId: string): Promise<void> => {
  try {
    await kv.delete(campaignDeltaKey(campaignId), { scope: 'WORKSPACE' });
  } catch (error) {
    logger.debug('wa.campaign.delta_clear_failed', { campaignId, ...describeError(error) });
  }
};
