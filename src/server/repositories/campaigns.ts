import type { CampaignStatus } from '../../domain/constants';
import { nodesOf, query, type JsonObject } from './base';

/**
 * `whatsappCampaign`.
 *
 * Grew from the narrow slice the sender needed — it touches campaigns only to
 * stop a run whose template is wrong for every recipient — into the full
 * record the runner, the control route and the rollup read. The field list is
 * shared so that a campaign loaded by one of them is the same shape as a
 * campaign loaded by another; a runner reading a subset and writing a patch
 * built from it is how a status ends up overwritten with a stale value.
 */

const CAMPAIGN_FIELDS = {
  id: true,
  name: true,
  status: true,
  statusReason: true,
  scheduledAt: true,
  startedAt: true,
  completedAt: true,
  audienceDefinition: true,
  variableMapping: true,
  recipientCount: true,
  excludedCount: true,
  exclusionBreakdown: true,
  queuedCount: true,
  sentCount: true,
  deliveredCount: true,
  readCount: true,
  failedCount: true,
  skippedCount: true,
  respondedCount: true,
  estimatedCostUsd: true,
  actualCostUsd: true,
  maxFailureRatePct: true,
  pacingObserved: true,
  lastRunTickAt: true,
  testRecipientPhones: true,
  templateId: true,
  accountId: true,
  ownerId: true,
} as const;

export type WhatsappCampaignRecord = {
  id: string;
  name?: string | null;
  status?: string | null;
  statusReason?: string | null;
  scheduledAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  audienceDefinition?: JsonObject | null;
  variableMapping?: JsonObject | null;
  recipientCount?: number | null;
  excludedCount?: number | null;
  exclusionBreakdown?: JsonObject | null;
  queuedCount?: number | null;
  sentCount?: number | null;
  deliveredCount?: number | null;
  readCount?: number | null;
  failedCount?: number | null;
  skippedCount?: number | null;
  respondedCount?: number | null;
  estimatedCostUsd?: number | null;
  actualCostUsd?: number | null;
  maxFailureRatePct?: number | null;
  pacingObserved?: boolean | null;
  lastRunTickAt?: string | null;
  testRecipientPhones?: string[] | null;
  templateId?: string | null;
  accountId?: string | null;
  ownerId?: string | null;
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

/**
 * Campaigns in any of the given states, oldest tick first.
 *
 * The ordering is what makes the runner fair: with a cap of three campaigns a
 * tick, sorting by `lastRunTickAt` ascending means a campaign that has waited
 * longest goes next, so four concurrent campaigns interleave instead of the
 * first three starving the fourth until they finish.
 */
export const listCampaignsByStatus = async (
  statuses: CampaignStatus[],
  limit = 20,
): Promise<WhatsappCampaignRecord[]> => {
  if (statuses.length === 0) return [];

  const result = await query(
    (client) =>
      client.query({
        whatsappCampaigns: {
          __args: {
            filter: { status: { in: statuses } },
            orderBy: [{ lastRunTickAt: 'AscNullsFirst' }],
            first: limit,
          },
          edges: { node: CAMPAIGN_FIELDS },
        },
      }),
    'campaigns.listByStatus',
  );

  return nodesOf<WhatsappCampaignRecord>(result.whatsappCampaigns);
};

/** Campaigns due to start: `SCHEDULED` with a time that has passed. */
export const listDueCampaigns = async (
  now: Date,
  limit = 20,
): Promise<WhatsappCampaignRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaigns: {
          __args: {
            filter: {
              status: { eq: 'SCHEDULED' },
              scheduledAt: { lte: now.toISOString() },
            },
            first: limit,
          },
          edges: { node: CAMPAIGN_FIELDS },
        },
      }),
    'campaigns.listDue',
  );

  return nodesOf<WhatsappCampaignRecord>(result.whatsappCampaigns);
};

export type CampaignPatch = {
  name?: string;
  status?: CampaignStatus;
  statusReason?: string | null;
  scheduledAt?: string | null;
  audienceDefinition?: Record<string, unknown> | null;
  variableMapping?: Record<string, unknown> | null;
  recipientCount?: number;
  excludedCount?: number;
  exclusionBreakdown?: Record<string, unknown> | null;
  queuedCount?: number;
  sentCount?: number;
  deliveredCount?: number;
  readCount?: number;
  failedCount?: number;
  skippedCount?: number;
  respondedCount?: number;
  estimatedCostUsd?: number | null;
  actualCostUsd?: number | null;
  maxFailureRatePct?: number;
  testRecipientPhones?: string[];
  /** A state Meta puts a large marketing batch into, not an error (FR-CAM-11). */
  pacingObserved?: boolean;
  lastRunTickAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  templateId?: string | null;
  accountId?: string | null;
  ownerId?: string | null;
};

export const patchCampaign = async (id: string, data: CampaignPatch): Promise<void> => {
  await query(
    (client) => client.mutation({ updateWhatsappCampaign: { __args: { id, data }, id: true } }),
    'campaigns.patch',
  );
};

export const createCampaign = async (
  data: CampaignPatch & { name: string },
): Promise<WhatsappCampaignRecord> => {
  const result = await query(
    (client) =>
      client.mutation({
        createWhatsappCampaign: { __args: { data }, ...CAMPAIGN_FIELDS },
      }),
    'campaigns.create',
  );

  return result.createWhatsappCampaign as WhatsappCampaignRecord;
};
