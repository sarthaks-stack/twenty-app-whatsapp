import { MESSAGE_STATUS, type MessageStatus } from './constants';

/**
 * Outbound status progression (AR-9).
 *
 * Meta gives **no ordering guarantee** and retries for 7 days, so a `delivered`
 * can arrive before its `sent`, twice, or a week late. The machine is therefore
 * strictly monotonic by rank and never compares timestamps — Meta's timestamps
 * are 1-second resolution and were observed colliding across different messages
 * (specs/03 §5), so they cannot order anything even in principle.
 */

const RANK: Record<MessageStatus, number> = {
  [MESSAGE_STATUS.QUEUED]: 0,
  [MESSAGE_STATUS.ACCEPTED]: 1,
  [MESSAGE_STATUS.SENT]: 2,
  [MESSAGE_STATUS.DELIVERED]: 3,
  // read and played are peers: a voice note played does not outrank read, and
  // whichever arrives first wins the field while both are timestamped.
  [MESSAGE_STATUS.READ]: 4,
  [MESSAGE_STATUS.PLAYED]: 4,
  [MESSAGE_STATUS.FAILED]: 0,
};

export const advanceStatus = (
  current: MessageStatus,
  incoming: MessageStatus,
): MessageStatus => {
  // Terminal: a failed message is never resurrected by a late success event.
  if (current === MESSAGE_STATUS.FAILED) return MESSAGE_STATUS.FAILED;

  if (incoming === MESSAGE_STATUS.FAILED) {
    // Meta emits failures after delivery for post-delivery policy actions. The
    // message *was* delivered, so the status holds — but the error is still
    // recorded in statusTimestamps and errorDetail by the caller.
    return RANK[current] >= RANK[MESSAGE_STATUS.DELIVERED] ? current : MESSAGE_STATUS.FAILED;
  }

  return RANK[incoming] > RANK[current] ? incoming : current;
};

/** Terminal states never re-enter the pipeline. */
export const isTerminal = (status: MessageStatus): boolean =>
  status === MESSAGE_STATUS.FAILED ||
  status === MESSAGE_STATUS.READ ||
  status === MESSAGE_STATUS.PLAYED;

/**
 * Every observed transition is recorded even when the status field does not
 * move, so the audit trail survives out-of-order delivery. First observation
 * wins for a given status: a duplicate webhook must not rewrite history.
 */
export const recordStatusTimestamp = (
  timestamps: Partial<Record<MessageStatus, number>> | null | undefined,
  status: MessageStatus,
  epochSeconds: number,
): Partial<Record<MessageStatus, number>> => {
  const next = { ...(timestamps ?? {}) };
  if (next[status] === undefined) next[status] = epochSeconds;

  return next;
};

const META_STATUS_MAP: Record<string, MessageStatus> = {
  sent: MESSAGE_STATUS.SENT,
  delivered: MESSAGE_STATUS.DELIVERED,
  read: MESSAGE_STATUS.READ,
  played: MESSAGE_STATUS.PLAYED,
  failed: MESSAGE_STATUS.FAILED,
};

/** Meta reports lowercase; the column stores UPPER_SNAKE_CASE (specs/02 §13). */
export const fromMetaStatus = (value: string | undefined): MessageStatus | null =>
  value === undefined ? null : (META_STATUS_MAP[value.toLowerCase()] ?? null);
