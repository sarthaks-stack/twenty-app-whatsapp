import { CAMPAIGN_STATUS, type CampaignStatus } from '../constants';

/**
 * The campaign state machine (specs/07 §1).
 *
 * Every transition in the system goes through one table. Two functions write
 * campaign status — `wa-campaign-control` for what a human asks for and
 * `wa-campaign-runner` for what the machine decides — and without a shared
 * edge list they would disagree at exactly the states that matter: whether a
 * cancelled campaign can be resumed, whether a completed one can be paused,
 * whether a runner tick can revive something an admin just stopped.
 *
 * The table is deliberately conservative. An edge that is not listed is
 * refused, so adding a state or a path is a code change with a test rather
 * than something a handler can improvise.
 */

const S = CAMPAIGN_STATUS;

/**
 * Allowed destinations, keyed by current state.
 *
 * `PAUSED → SCHEDULED` is absent on purpose: resuming a paused campaign means
 * running it now, not putting it back in a queue behind a `scheduledAt` that
 * has already passed.
 *
 * `FAILED → PAUSED` exists because a failure is usually an admin-fixable
 * condition (a revoked template, a broken token). Recovering lands in `PAUSED`
 * rather than `RUNNING` so that a human, not a retry, decides to resume.
 */
export const ALLOWED_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  [S.DRAFT]: [S.SNAPSHOTTING, S.CANCELLED],
  [S.SNAPSHOTTING]: [S.READY, S.FAILED, S.CANCELLED],
  [S.READY]: [S.SCHEDULED, S.RUNNING, S.SNAPSHOTTING, S.DRAFT, S.CANCELLED],
  [S.SCHEDULED]: [S.RUNNING, S.PAUSED, S.CANCELLED],
  [S.RUNNING]: [S.PAUSED, S.TIER_WAITING, S.COMPLETED, S.FAILED, S.CANCELLED],
  [S.PAUSED]: [S.RUNNING, S.CANCELLED, S.FAILED],
  [S.TIER_WAITING]: [S.RUNNING, S.PAUSED, S.CANCELLED, S.FAILED],
  [S.COMPLETED]: [],
  [S.CANCELLED]: [],
  [S.FAILED]: [S.PAUSED, S.CANCELLED],
};

export const TERMINAL_STATUSES: readonly CampaignStatus[] = [
  S.COMPLETED,
  S.CANCELLED,
];

export const isTerminal = (status: CampaignStatus): boolean =>
  TERMINAL_STATUSES.includes(status);

/**
 * Whether the runner should be looking at this campaign at all.
 *
 * `FAILED` is excluded: it is recoverable but not by a tick, and a runner that
 * retried it would spend every minute re-discovering the same revoked
 * template.
 */
export const isActive = (status: CampaignStatus): boolean =>
  status === S.RUNNING || status === S.TIER_WAITING;

/**
 * The states from which a campaign may be **deleted** (FR-CAM-8, SEC-12).
 *
 * Deletion is not a transition — it removes the row rather than moving it — but
 * it is the same kind of judgement as `cancel is final`, so it lives beside the
 * table rather than in the route that offers it.
 *
 * The rule is narrow on purpose: only a campaign that was never launched. A
 * `CANCELLED` or `COMPLETED` campaign is the record of what went out to real
 * people — its counters, its exclusion breakdown and its recipient rows are the
 * evidence the launch audit line points at — and a record that can be deleted
 * by whoever is embarrassed by it is not evidence. Stopping a campaign is
 * `cancel`; there is no follow-up that makes it never have happened.
 *
 * `SNAPSHOTTING` is included because a build in flight has still sent nothing.
 * The snapshot job finds the campaign gone and stops, which is the same
 * outcome as a build cancelled halfway.
 */
export const DELETABLE_STATUSES: readonly CampaignStatus[] = [
  S.DRAFT,
  S.SNAPSHOTTING,
  S.READY,
];

export type DeletionVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether this campaign may be deleted.
 *
 * Takes the loose record shape both callers hold — the route reads it from the
 * repository, the detail screen from the feed — because the two agree on the
 * four fields that matter and on nothing else.
 *
 * The counters are checked *as well as* the status, and not as a formality: a
 * campaign that reached `READY`, launched, and was somehow written back to
 * `DRAFT` would pass the status test while holding sent messages. The status is
 * what a campaign says about itself; `sentCount` and `startedAt` are what
 * happened.
 */
export const canDeleteCampaign = (campaign: {
  status?: string | null;
  sentCount?: number | null;
  queuedCount?: number | null;
  startedAt?: string | null;
}): DeletionVerdict => {
  const status = (campaign.status ?? S.DRAFT) as CampaignStatus;

  if (!DELETABLE_STATUSES.includes(status)) {
    return {
      ok: false,
      reason: `A ${status} campaign is the record of a send that was made and cannot be deleted. Only a campaign that was never launched can be.`,
    };
  }

  const moved = (campaign.sentCount ?? 0) > 0 || (campaign.queuedCount ?? 0) > 0;

  if (moved || (campaign.startedAt ?? null) !== null) {
    return {
      ok: false,
      reason:
        'This campaign has already queued or sent messages, so it is kept as the record of them. Cancel it if you need it stopped.',
    };
  }

  return { ok: true };
};

/**
 * The states a campaign may be **archived** from (FR-CAM-10).
 *
 * Archiving hides a finished campaign from the campaigns page and changes
 * nothing else: no status moves, no counter is touched, the rollup keeps
 * aggregating its delivery statuses. It is the answer to "I cannot delete a
 * cancelled campaign and I do not want to look at forty of them", which is the
 * other half of the deletion rule above — a record that must be kept still has
 * to be got out of the way.
 *
 * Only campaigns that have stopped. A `RUNNING` or `SCHEDULED` campaign hidden
 * from the only page that shows it would keep sending to thousands of people
 * with nothing on screen to pause it, which is the one outcome archiving must
 * never produce. `FAILED` is included — it has stopped — and is the reason
 * `transitionCampaign` unarchives: a failed campaign an admin recovers has to
 * come back into view.
 */
export const ARCHIVABLE_STATUSES: readonly CampaignStatus[] = [
  S.COMPLETED,
  S.CANCELLED,
  S.FAILED,
];

export type ArchiveVerdict = { ok: true } | { ok: false; reason: string };

export const isArchivedCampaign = (campaign: { archivedAt?: string | null }): boolean =>
  (campaign.archivedAt ?? null) !== null;

/**
 * Whether this campaign may be archived.
 *
 * Unarchiving has no rule of its own: anything that is archived can be brought
 * back, always. A hidden state you cannot leave is the failure the inbox's
 * `closed` filter was added to avoid, and it would be worse here — the campaign
 * that cannot be found again is also the one that cannot be reported on.
 */
export const canArchiveCampaign = (campaign: {
  status?: string | null;
}): ArchiveVerdict => {
  const status = (campaign.status ?? S.DRAFT) as CampaignStatus;

  if (!ARCHIVABLE_STATUSES.includes(status)) {
    return {
      ok: false,
      reason: `A ${status} campaign has not finished, so it cannot be archived. Cancel it first if you want it out of the way.`,
    };
  }

  return { ok: true };
};

export type TransitionVerdict =
  | { ok: true; noop: boolean }
  | { ok: false; reason: string };

/**
 * Whether an edge may be taken.
 *
 * A transition to the state a campaign is already in is **allowed and marked
 * a no-op** rather than refused. FR-CAM-8 requires the control actions to be
 * idempotent, and the alternative — every caller checking first — is the
 * version where one of them forgets and pausing twice returns a 409.
 */
export const canTransition = (
  from: CampaignStatus,
  to: CampaignStatus,
): TransitionVerdict => {
  if (from === to) return { ok: true, noop: true };

  if (isTerminal(from)) {
    return { ok: false, reason: `${from} is terminal: a campaign cannot leave it` };
  }

  return ALLOWED_TRANSITIONS[from].includes(to)
    ? { ok: true, noop: false }
    : { ok: false, reason: `${from} cannot become ${to}` };
};

/**
 * The reasons a campaign stops, as a closed set (specs/07 §8).
 *
 * These strings reach the operator through `statusReason` and drive what the
 * pre-flight and detail panels explain, so they are constants rather than
 * prose written at each call site.
 */
export const STATUS_REASON = {
  CIRCUIT_BREAKER: 'circuit_breaker',
  QUALITY_RED: 'quality_red',
  TIER_EXHAUSTED: 'tier_exhausted',
  TEMPLATE_UNAVAILABLE: 'template_unavailable',
  ACCOUNT_ERROR: 'account_error',
  SNAPSHOT_FAILED: 'snapshot_failed',
  CANCELLED_BY_ADMIN: 'cancelled_by_admin',
  PAUSED_BY_ADMIN: 'paused_by_admin',
  RESUMED_BY_ADMIN: 'resumed_by_admin',
  COMPLETED: 'completed',
} as const;
export type StatusReason = (typeof STATUS_REASON)[keyof typeof STATUS_REASON];

/**
 * Whether a guardrail pause should be re-applied on resume.
 *
 * A campaign paused for `quality_red` must not resume while the rating is
 * still red, and the check that decides that is the same one the runner
 * performs each tick. Resume therefore re-runs the guardrails rather than
 * trusting that whatever stopped the campaign has been fixed — an assumption
 * that would send the next batch straight into the condition that tripped it.
 */
export const RESUME_RECHECKS_GUARDRAILS = true;
