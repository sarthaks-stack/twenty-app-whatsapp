/**
 * Which campaigns a filter shows, and how far a running one has got.
 *
 * Pure and separate from the view for the same reason the inbox's list logic
 * is: "Needs attention" is a judgement about four statuses and a failure
 * count, and a judgement is a thing to test rather than to read off a JSX
 * conditional.
 */

export const CAMPAIGN_FILTERS = [
  'all',
  'drafts',
  'scheduled',
  'running',
  'completed',
  'attention',
] as const;

export type CampaignFilter = (typeof CAMPAIGN_FILTERS)[number];

/** The statuses that mean "this campaign is moving right now". */
export const RUNNING_STATUSES = new Set([
  'RUNNING',
  'SNAPSHOTTING',
  'TIER_WAITING',
  'SCHEDULED',
]);

const number = (value: unknown): number => {
  const parsed = Number(value ?? 0);

  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Whether a campaign is asking for a human.
 *
 * Three separate things qualify, and lumping them under one word is the point:
 * an operator scanning a list wants one place to look, not three columns to
 * compare.
 *
 * - It broke (`FAILED`), or someone stopped it and it is still stopped
 *   (`PAUSED`).
 * - It is `READY` — built, costed and waiting on a launch nobody has pressed.
 *   That is the state a campaign sits in when it is forgotten.
 * - It ran and some of it did not arrive.
 */
export const needsAttention = (campaign: Record<string, unknown>): boolean => {
  const status = String(campaign.status ?? '');

  if (status === 'FAILED' || status === 'PAUSED' || status === 'READY') return true;

  return number(campaign.failedCount) > 0;
};

export const matchesCampaignFilter = (
  campaign: Record<string, unknown>,
  filter: CampaignFilter,
): boolean => {
  const status = String(campaign.status ?? '');

  switch (filter) {
    case 'drafts':
      return status === 'DRAFT' || status === 'SNAPSHOTTING';
    case 'scheduled':
      return status === 'SCHEDULED';
    case 'running':
      return status === 'RUNNING' || status === 'TIER_WAITING';
    case 'completed':
      return status === 'COMPLETED' || status === 'CANCELLED';
    case 'attention':
      return needsAttention(campaign);
    default:
      return true;
  }
};

export const matchesCampaignSearch = (
  campaign: Record<string, unknown>,
  query: string,
): boolean => {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) return true;

  return String(campaign.name ?? '').toLowerCase().includes(needle);
};

/**
 * The list an operator actually sees.
 *
 * Actionable campaigns first, then everything else, each group left in the
 * server's order (newest first). A list sorted purely by date buries the
 * campaign that is paused mid-send under three drafts written this morning —
 * and the paused one is the only row on the screen that needs anybody.
 */
export const orderCampaigns = <T extends Record<string, unknown>>(campaigns: T[]): T[] => [
  ...campaigns.filter(
    (campaign) => RUNNING_STATUSES.has(String(campaign.status)) || needsAttention(campaign),
  ),
  ...campaigns.filter(
    (campaign) => !RUNNING_STATUSES.has(String(campaign.status)) && !needsAttention(campaign),
  ),
];

export const visibleCampaigns = <T extends Record<string, unknown>>(
  campaigns: T[],
  filter: CampaignFilter,
  search: string,
): T[] =>
  orderCampaigns(
    campaigns.filter(
      (campaign) =>
        matchesCampaignFilter(campaign, filter) && matchesCampaignSearch(campaign, search),
    ),
  );

export type Funnel = { key: string; value: number; share: number }[];

/**
 * The delivery funnel, as shares of the recipient count.
 *
 * Every bar is measured against `recipientCount` rather than against the stage
 * before it, so the bars are comparable to each other and to the audience —
 * "half of them read it" is the sentence this has to support. A campaign with
 * no recipients yields zero shares rather than `NaN`, which is what dividing
 * by the recipient count would otherwise produce on every draft.
 */
export const deliveryFunnel = (campaign: Record<string, unknown>): Funnel => {
  const total = number(campaign.recipientCount);

  return (
    [
      ['campaign.counter.recipientCount', total],
      ['campaign.counter.sentCount', number(campaign.sentCount)],
      ['campaign.counter.deliveredCount', number(campaign.deliveredCount)],
      ['campaign.counter.readCount', number(campaign.readCount)],
      ['campaign.counter.respondedCount', number(campaign.respondedCount)],
    ] as const
  ).map(([key, value]) => ({
    key,
    value,
    share: total === 0 ? 0 : Math.min(1, value / total),
  }));
};
