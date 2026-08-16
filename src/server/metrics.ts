import { kv } from 'twenty-sdk/logic-function';

import { describeError, logger } from './logger';

/**
 * kv-backed counters (NFR-O2).
 *
 * **Approximate by construction.** `kv` has no compare-and-swap, so a
 * read-modify-write under concurrency loses increments. That is stated here and
 * in the health panel rather than papered over, because the alternative — a
 * counter that looks authoritative and is not — would eventually be used for
 * billing. Campaign counters are derived from recipient *records* for exactly
 * this reason (specs/11 §2); these exist for trend detection and alerting.
 *
 * A metric write must never fail the work it measures: every path swallows its
 * error and logs at debug.
 */

const DAY = (at: Date): string => at.toISOString().slice(0, 10);

export const metricKey = (event: string, at: Date = new Date()): string =>
  `wa:metric:${event}:${DAY(at)}`;

export const increment = async (event: string, by = 1): Promise<void> => {
  const key = metricKey(event);

  try {
    const current = await kv.get<number>(key, { scope: 'WORKSPACE' });
    const next = (typeof current === 'number' ? current : 0) + by;

    await kv.set(key, next, { scope: 'WORKSPACE' });
  } catch (error) {
    logger.debug('metric.write_failed', { event, ...describeError(error) });
  }
};

/** Fire-and-forget: counters must never delay or fail the work they measure. */
export const count = (event: string, by = 1): void => {
  void increment(event, by);
};

export const read = async (event: string, at: Date = new Date()): Promise<number> => {
  try {
    const value = await kv.get<number>(metricKey(event, at), { scope: 'WORKSPACE' });

    return typeof value === 'number' ? value : 0;
  } catch {
    return 0;
  }
};

/**
 * Times an operation and records both a counter and a duration on the log line.
 * The duration belongs on the log rather than in `kv`: an average of a value
 * that loses writes is worse than no average at all.
 */
export const timed = async <T>(
  event: string,
  operation: () => Promise<T>,
  context: Record<string, unknown> = {},
): Promise<T> => {
  const startedAt = Date.now();

  try {
    const result = await operation();

    count(event);
    logger.debug(event, { ...context, durationMs: Date.now() - startedAt });

    return result;
  } catch (error) {
    count(`${event}_error`);
    logger.warn(`${event}_error`, {
      ...context,
      durationMs: Date.now() - startedAt,
      ...describeError(error),
    });

    throw error;
  }
};

export const METRIC = {
  WEBHOOK_VERIFY_ATTEMPT: 'wa.webhook.verify_attempt',
  WEBHOOK_VERIFY_OK: 'wa.webhook.verify_ok',
  WEBHOOK_VERIFY_REJECTED: 'wa.webhook.verify_rejected',
  WEBHOOK_SIGNATURE_REJECTED: 'wa.webhook.signature_rejected',
  WEBHOOK_UNCLAIMED: 'wa.webhook.unclaimed',
  WEBHOOK_FOREIGN_ENTRY: 'wa.webhook.foreign_entry',
  WEBHOOK_DEDUP_HIT: 'wa.webhook.dedup_hit',
  WEBHOOK_UNHANDLED_FIELD: 'wa.webhook.unhandled_field',

  INBOUND_PROCESSED: 'wa.inbound.processed',
  INBOUND_DEDUP_HIT: 'wa.inbound.dedup_hit',
  INBOUND_UNSUPPORTED_TYPE: 'wa.inbound.unsupported_type',
  INBOUND_AUTO_CREATED_PERSON: 'wa.inbound.auto_created_person',
  INBOUND_NEEDS_REVIEW: 'wa.inbound.needs_review',

  STATUS_PROCESSED: 'wa.status.processed',
  STATUS_ORPHAN: 'wa.status.orphan',
  STATUS_DOWNGRADE_IGNORED: 'wa.status.downgrade_ignored',
  STATUS_FAILED_TERMINAL: 'wa.status.failed_terminal',
  STATUS_FAILED_RETRYABLE: 'wa.status.failed_retryable',

  MEDIA_DOWNLOADED: 'wa.media.downloaded',
  MEDIA_DEFERRED: 'wa.media.deferred',
  MEDIA_RETRY: 'wa.media.retry',
  MEDIA_INTEGRITY_FAIL: 'wa.media.integrity_fail',
  MEDIA_FAILED: 'wa.media.failed',

  SEND_SCHEDULED: 'wa.send.scheduled',
  SEND_ACCEPTED: 'wa.send.accepted',
  SEND_RETRY: 'wa.send.retry',
  SEND_FAILED_TERMINAL: 'wa.send.failed_terminal',
  SEND_SKIP_NONQUEUED: 'wa.send.skip_nonqueued',
  SEND_UNMAPPED_ERROR: 'wa.send.unmapped_error',
  /**
   * The one that must never be routine. Each occurrence is a message Meta may
   * or may not have delivered, resolved by a human reading the thread.
   */
  SEND_UNKNOWN_ACCEPTANCE: 'wa.send.unknown_acceptance',
  SEND_SPACING_DEFERRED: 'wa.send.spacing_deferred',
  SEND_MEDIA_UPLOADED: 'wa.send.media_uploaded',
  SEND_MEDIA_CACHE_HIT: 'wa.send.media_cache_hit',

  POLICY_DENIED_ACCOUNT: 'wa.policy.denied_account',
  POLICY_DENIED_WINDOW: 'wa.policy.denied_window',
  POLICY_DENIED_CONSENT: 'wa.policy.denied_consent',
  POLICY_DENIED_TEMPLATE: 'wa.policy.denied_template',
  POLICY_DENIED_QUALITY: 'wa.policy.denied_quality',
  POLICY_DENIED_BLOCKED: 'wa.policy.denied_blocked',

  WINDOW_SWEPT: 'wa.window.swept',
  THREAD_AUTO_CLOSED: 'wa.thread.auto_closed',

  HEALTH_ACCOUNT_ERROR: 'wa.health.account_error',
  HEALTH_WEBHOOK_STALE: 'wa.health.webhook_stale',
  HEALTH_STUCK_REQUEUED: 'wa.health.stuck_requeued',
  HEALTH_STUCK_FAILED: 'wa.health.stuck_failed',
  HEALTH_TIER_WINDOW_ROLLED: 'wa.health.tier_window_rolled',

  CONSENT_OPTED_IN: 'wa.consent.opted_in',
  CONSENT_OPTED_OUT: 'wa.consent.opted_out',
  /** A repeat STOP that changed nothing, and so answered nothing (FR-CON-3). */
  CONSENT_CONFIRMATION_SUPPRESSED: 'wa.consent.confirmation_suppressed',
  CONSENT_IMPORTED: 'wa.consent.imported',
  CONSENT_BACKFILLED: 'wa.consent.backfilled',
  ERASURE_COMPLETED: 'wa.erasure.completed',

  CAMPAIGN_QUEUED: 'wa.campaign.queued',
  CAMPAIGN_STALE_CLAIM_REVERTED: 'wa.campaign.stale_claim_reverted',
  CAMPAIGN_TIER_WAITING: 'wa.campaign.tier_waiting',
  CAMPAIGN_PAUSED_BY_GUARDRAIL: 'wa.campaign.paused_by_guardrail',
  CAMPAIGN_SNAPSHOT_PAGE: 'wa.campaign.snapshot_page',
  CAMPAIGN_STATS_ROLLED: 'wa.campaign.stats_rolled',

  TEMPLATE_SYNCED: 'wa.template.synced',
  TEMPLATE_DISAPPEARED: 'wa.template.disappeared',
  TEMPLATE_RECATEGORISED: 'wa.template.recategorised',
  TEMPLATE_SUBMITTED: 'wa.template.submitted',
  TEMPLATE_SUBMIT_THROTTLED: 'wa.template.submit_throttled',

  TEMPLATE_EVENT: 'wa.template.event',
  TEMPLATE_UNPUBLISHED_ON_DEGRADATION: 'wa.template.unpublished_on_degradation',

  ACCOUNT_QUALITY_CHANGE: 'wa.account.quality_change',
  ACCOUNT_RESTRICTED: 'wa.account.restricted',

  API_CORE_CALL: 'wa.api.core_call',
  API_CORE_ERROR: 'wa.api.core_error',
  API_CORE_429: 'wa.api.core_429',
} as const;
