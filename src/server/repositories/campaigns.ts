import type { CampaignStatus } from '../../domain/constants';
import { nodesOf, query } from './base';

/**
 * `whatsappCampaign` — the narrow slice the outbound path needs.
 *
 * The sender touches campaigns for one reason: a `terminal_content` error means
 * the template mapping is wrong for *every* recipient, not just this one, so
 * the run has to stop. Leaving it going would spend the whole audience
 * producing the same rejection several thousand times, and the failure counter
 * would only notice after the circuit breaker's window had filled.
 *
 * Building, launching and counting belong to the campaign phase; this file
 * stays deliberately small so that they can grow their own repository without
 * inheriting whatever the sender needed first.
 */

const CAMPAIGN_FIELDS = {
  id: true,
  name: true,
  status: true,
  statusReason: true,
  templateId: true,
  accountId: true,
} as const;

export type WhatsappCampaignRecord = {
  id: string;
  name?: string | null;
  status?: string | null;
  statusReason?: string | null;
  templateId?: string | null;
  accountId?: string | null;
};

export const findCampaignById = async (
  id: string,
): Promise<WhatsappCampaignRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaigns: {
          __args: { filter: { id: { eq: id } }, first: 1 },
          edges: { node: CAMPAIGN_FIELDS },
        },
      }),
    'campaigns.findById',
  );

  return nodesOf<WhatsappCampaignRecord>(result.whatsappCampaigns)[0] ?? null;
};

export type CampaignPatch = {
  status?: CampaignStatus;
  statusReason?: string | null;
  queuedCount?: number;
  sentCount?: number;
  deliveredCount?: number;
  readCount?: number;
  failedCount?: number;
  skippedCount?: number;
  respondedCount?: number;
  actualCostUsd?: number;
  /** A state Meta puts a large marketing batch into, not an error (FR-CAM-11). */
  pacingObserved?: boolean;
  lastRunTickAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
};

export const patchCampaign = async (id: string, data: CampaignPatch): Promise<void> => {
  await query(
    (client) => client.mutation({ updateWhatsappCampaign: { __args: { id, data }, id: true } }),
    'campaigns.patch',
  );
};
