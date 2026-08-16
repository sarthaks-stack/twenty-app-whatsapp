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

/** A stable string for a delta, so two of them can be compared for sameness. */
export const deltaFingerprint = (delta: Record<string, number> | null): string =>
  delta === null
    ? ''
    : JSON.stringify(
        Object.keys(delta)
          .sort()
          .map((key) => [key, delta[key]]),
      );

/**
 * Clears the hint only if nothing has been added to it since it was read.
 *
 * A recount takes several round trips, and a delivery status landing in the
 * middle of one writes a delta the recount did not see. An unconditional clear
 * threw that away, so the campaign's numbers stayed one event behind until
 * something else happened to move them — which, for the last delivery of a
 * finished campaign, is never (D-39).
 *
 * `kv` has no compare-and-swap, so this is a read-then-delete and a delta
 * written *between* those two calls is still lost. That window is a fraction of
 * the one it replaces, and the failure it leaves is the harmless direction: a
 * recount that runs again next tick.
 */
export const clearCampaignChangeIfUnchanged = async (
  campaignId: string,
  expected: Record<string, number> | null,
): Promise<boolean> => {
  const current = await readCampaignChange(campaignId);

  if (deltaFingerprint(current) !== deltaFingerprint(expected)) return false;

  await clearCampaignChange(campaignId);

  return true;
};
