import { defineLogicFunction } from 'twenty-sdk/define';
import { kv } from 'twenty-sdk/logic-function';

import { LF_HEALTH_CHECK, LF_OUTBOUND_SENDER } from '../constants/universal-identifiers';
import {
  ACCOUNT_STATUS,
  MESSAGE_STATUS,
  MESSAGING_TIER,
  QUALITY,
  RECIPIENT_STATUS,
  type MessagingTier,
  type Quality,
} from '../domain/constants';
import { getProvider } from '../providers/whatsapp';
import {
  ERROR_CLASS,
  INTERNAL_ERROR,
  MetaApiError,
  classify,
} from '../providers/whatsapp/errors';
import { config } from '../server/config';
import { enqueue } from '../server/jobs';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import {
  listAccounts,
  patchAccount,
  type WhatsappAccountRecord,
} from '../server/repositories/accounts';
import { asJson, toDate, type JsonObject } from '../server/repositories/base';
import {
  findStaleClaimedRecipients,
  patchRecipients,
} from '../server/repositories/campaign-recipients';
import {
  findStuckQueuedMessages,
  patchMessage,
  type WhatsappMessageRecord,
} from '../server/repositories/messages';
import { findFailedWebhookEvents } from '../server/repositories/webhook-events';

/**
 * The hourly sweep that notices what nothing else would (NFR-O3, NFR-R3,
 * FR-ACC-4, specs/11 §3).
 *
 * Every check here covers a failure whose defining property is *silence*: a
 * token that expired and now fails every send identically, a webhook
 * subscription that quietly stopped delivering, a message whose worker died
 * between the record and the Meta call, a campaign claim taken by a runner that
 * never came back. None of them raises an error anywhere, and all of them look
 * exactly like a quiet afternoon.
 */

/** A message queued longer than this never reached the sender (NFR-R3). */
export const STUCK_MESSAGE_MS = 15 * 60_000;

/** A claim is a lease; a runner that dies must not hold recipients forever. */
export const STALE_CLAIM_MS = 10 * 60_000;

export const TIER_WINDOW_MS = 24 * 3_600_000;

/**
 * How many consecutive probe failures it takes to stop an account sending.
 *
 * `ERROR` is not a diagnosis, it is a decision: the policy gate reads it as
 * "send nothing". A single failed probe used to be enough, so one refused
 * connection to Meta's Graph API silenced a working number until the next hour's
 * check — an outage caused entirely by our own monitoring (D-31). Three probes
 * is three hours of a condition that keeps failing, which is a real fault.
 */
export const PROBE_FAILURES_BEFORE_ERROR = 3;

export type AccountHealth = {
  accountId: string;
  /** `degraded`: the probe failed, but transiently and not yet often enough. */
  probe: 'ok' | 'failed' | 'degraded' | 'skipped';
  webhookStale: boolean;
  tierWindowRolled: boolean;
};

export type HealthResult = {
  accounts: AccountHealth[];
  stuckRequeued: number;
  stuckFailed: number;
  staleClaimsReleased: number;
  failedWebhookEvents: number;
};

const QUALITY_FROM_META: Record<string, Quality> = {
  GREEN: QUALITY.GREEN,
  YELLOW: QUALITY.YELLOW,
  RED: QUALITY.RED,
  UNKNOWN: QUALITY.UNKNOWN,
};

const TIER_FROM_META: Record<string, MessagingTier> = {
  TIER_250: MESSAGING_TIER.TIER_250,
  TIER_1K: MESSAGING_TIER.TIER_1K,
  TIER_2K: MESSAGING_TIER.TIER_2K,
  TIER_10K: MESSAGING_TIER.TIER_10K,
  TIER_100K: MESSAGING_TIER.TIER_100K,
  TIER_UNLIMITED: MESSAGING_TIER.TIER_UNLIMITED,
};

/**
 * Meta reports throughput as a level, not a number (appendix A §8).
 *
 * Recorded as messages per second so the health panel can show the headroom
 * above `sendThrottlePerSecond` — an unfamiliar word like `STANDARD` means
 * nothing next to a throttle of 20. An unrecognised level leaves the stored
 * value alone rather than guessing: a wrong ceiling here would licence a burst.
 */
export const throughputPerSecond = (level: string | null | undefined): number | null => {
  switch ((level ?? '').toUpperCase()) {
    case 'STANDARD':
      return 80;
    case 'HIGH':
      return 1000;
    default:
      return null;
  }
};

/**
 * Staleness only counts for a number that has received an event before.
 *
 * A freshly connected number that nobody has messaged yet is not broken, and
 * reporting it as such on the day of installation would teach the operator to
 * ignore the health panel — which is the only alerting channel the platform
 * gives us (D-10).
 */
export const isWebhookStale = ({
  lastEventAt,
  now,
  stalenessHours,
}: {
  lastEventAt: Date | null;
  now: Date;
  stalenessHours: number;
}): boolean => {
  if (lastEventAt === null) return false;

  return now.getTime() - lastEventAt.getTime() > stalenessHours * 3_600_000;
};

/** Whether the rolling 24-hour unique-recipient window has lapsed (AR-21). */
export const shouldRollTierWindow = ({
  startedAt,
  now,
}: {
  startedAt: Date | null;
  now: Date;
}): boolean => startedAt === null || now.getTime() - startedAt.getTime() >= TIER_WINDOW_MS;

/**
 * Second sighting fails the message.
 *
 * The re-enqueue is recorded on `statusTimestamps` rather than in `kv` or a new
 * column: it is a lifecycle event like every other entry there, it survives a
 * cache eviction, and an operator reading the record can see that the system
 * already tried once before giving up.
 */
export const stuckAction = (
  message: Pick<WhatsappMessageRecord, 'statusTimestamps'>,
): 'requeue' | 'fail' => {
  const timestamps = asJson<JsonObject>(message.statusTimestamps, {});

  return timestamps.requeuedAt === undefined ? 'requeue' : 'fail';
};

export const probeFailureKey = (accountId: string): string =>
  `wa:probe-failures:${accountId}`;

/**
 * Whether a failed probe should stop the account sending.
 *
 * A 429 or a 5xx says something about the minute we asked in; a rejected
 * credential says something about the account. Only the second is a reason to
 * stop, and even the first becomes one if it keeps happening.
 */
export const probeVerdict = (
  error: unknown,
  consecutiveFailures: number,
): 'error' | 'degraded' => {
  const transient =
    error instanceof MetaApiError &&
    classify(error).class === ERROR_CLASS.RETRYABLE_BACKOFF;

  return transient && consecutiveFailures < PROBE_FAILURES_BEFORE_ERROR ? 'degraded' : 'error';
};

const readProbeFailures = async (accountId: string): Promise<number> => {
  try {
    return (await kv.get<number>(probeFailureKey(accountId), { scope: 'WORKSPACE' })) ?? 0;
  } catch {
    /** Without the counter, fall back to the old behaviour: one strike. */
    return PROBE_FAILURES_BEFORE_ERROR;
  }
};

const writeProbeFailures = async (accountId: string, value: number): Promise<void> => {
  try {
    await kv.set(probeFailureKey(accountId), value, { scope: 'WORKSPACE' });
  } catch (error) {
    logger.warn('wa.health.probe_counter_failed', { accountId, ...describeError(error) });
  }
};

const probeAccount = async (
  account: WhatsappAccountRecord,
): Promise<'ok' | 'failed' | 'degraded' | 'skipped'> => {
  if (typeof account.phoneNumberId !== 'string') return 'skipped';

  try {
    const number = await getProvider().getPhoneNumber(account.phoneNumberId);
    const tier = TIER_FROM_META[(number.messagingLimitTier ?? '').toUpperCase()];
    const throughput = throughputPerSecond(number.throughputLevel);

    await patchAccount(account.id, {
      status: ACCOUNT_STATUS.CONNECTED,
      statusDetail: null,
      displayPhoneNumber: number.displayPhoneNumber,
      displayName: number.verifiedName,
      qualityRating:
        QUALITY_FROM_META[(number.qualityRating ?? '').toUpperCase()] ?? QUALITY.UNKNOWN,
      ...(tier === undefined ? {} : { messagingLimitTier: tier }),
      ...(throughput === null ? {} : { throughputPerSecond: throughput }),
      tokenLastCheckedAt: new Date().toISOString(),
    });

    await writeProbeFailures(account.id, 0);

    return 'ok';
  } catch (error) {
    const detail =
      error instanceof MetaApiError
        ? `${error.code ?? error.httpStatus ?? 'error'}: ${error.details ?? error.message}`
        : String(error);

    const failures = (await readProbeFailures(account.id)) + 1;

    await writeProbeFailures(account.id, failures);

    /**
     * A transient failure is recorded but does not stop the account. The
     * detail still lands on the record, so the health panel shows what
     * happened, and the counter decides when "what happened" becomes "what is
     * wrong" (D-31).
     */
    if (probeVerdict(error, failures - 1) === 'degraded') {
      await patchAccount(account.id, {
        statusDetail: `Probe failed (${failures}/${PROBE_FAILURES_BEFORE_ERROR}): ${detail}`.slice(
          0,
          500,
        ),
        tokenLastCheckedAt: new Date().toISOString(),
      });

      count(METRIC.HEALTH_PROBE_DEGRADED);
      logger.warn('wa.health.probe_degraded', { accountId: account.id, failures, detail });

      return 'degraded';
    }

    /**
     * `ERROR` pauses sending through the policy gate's first rule, which is the
     * point: with a dead token every send would fail identically and each
     * failure would look like a separate incident.
     */
    await patchAccount(account.id, {
      status: ACCOUNT_STATUS.ERROR,
      statusDetail: detail.slice(0, 500),
      tokenLastCheckedAt: new Date().toISOString(),
    });

    count(METRIC.HEALTH_ACCOUNT_ERROR);
    logger.error('wa.health.account_error', { accountId: account.id, detail });

    return 'failed';
  }
};

const sweepStuckMessages = async (
  now: Date,
): Promise<{ requeued: number; failed: number }> => {
  const stuck = await findStuckQueuedMessages(new Date(now.getTime() - STUCK_MESSAGE_MS));

  let requeued = 0;
  let failed = 0;

  for (const message of stuck) {
    const timestamps = asJson<JsonObject>(message.statusTimestamps, {});

    if (stuckAction(message) === 'requeue') {
      await patchMessage(message.id, {
        statusTimestamps: { ...timestamps, requeuedAt: Math.floor(now.getTime() / 1000) },
      });

      await enqueue({
        logicFunctionUniversalIdentifier: LF_OUTBOUND_SENDER,
        payload: { messageId: message.id },
        retryLimit: 0,
        correlationId: message.id,
      });

      requeued += 1;
      continue;
    }

    await patchMessage(message.id, {
      status: MESSAGE_STATUS.FAILED,
      errorCode: INTERNAL_ERROR.INTERNAL_TIMEOUT,
      errorDetail: 'The message stayed queued without reaching Meta',
      statusTimestamps: { ...timestamps, failed: Math.floor(now.getTime() / 1000) },
    });

    failed += 1;
  }

  count(METRIC.HEALTH_STUCK_REQUEUED, requeued);
  count(METRIC.HEALTH_STUCK_FAILED, failed);

  return { requeued, failed };
};

/** Everything the hourly sweep checks about one account. */
const checkAccount = async (
  account: WhatsappAccountRecord,
  now: Date,
  stalenessHours: number,
  log: ReturnType<typeof logger.child>,
): Promise<AccountHealth> => {
  const probe = await probeAccount(account);

  const webhookStale = isWebhookStale({
    lastEventAt: toDate(account.webhookLastEventAt),
    now,
    stalenessHours,
  });

  if (webhookStale) {
    count(METRIC.HEALTH_WEBHOOK_STALE);
    log.warn('wa.health.webhook_stale', {
      accountId: account.id,
      lastEventAt: account.webhookLastEventAt,
    });
  }

  /**
   * Rolling the tier window resets the unique-recipient count. Campaigns
   * parked in `TIER_WAITING` are woken by the runner's next tick reading the
   * reset counter — nothing here reaches into them, so the two can be
   * reasoned about separately.
   */
  const tierWindowRolled = shouldRollTierWindow({
    startedAt: toDate(account.tierWindowStartedAt),
    now,
  });

  if (tierWindowRolled) {
    await patchAccount(account.id, {
      tierUniqueUsersUsed: 0,
      tierWindowStartedAt: now.toISOString(),
    });

    count(METRIC.HEALTH_TIER_WINDOW_ROLLED);
  }

  return { accountId: account.id, probe, webhookStale, tierWindowRolled };
};

export const runHealthCheck = async (now: Date = new Date()): Promise<HealthResult> => {
  const log = logger.child({ fn: 'wa-health-check' });

  const accounts = await listAccounts([
    ACCOUNT_STATUS.CONNECTED,
    ACCOUNT_STATUS.ERROR,
    ACCOUNT_STATUS.PENDING,
  ]);

  const stalenessHours = config.webhookStalenessHours();
  const health: AccountHealth[] = [];

  /**
   * Each account is swept inside its own boundary (D-32).
   *
   * The checks after this loop — stuck messages, stale campaign claims, failed
   * webhook events — are the ones that unstick the *whole workspace*, and they
   * used to sit behind an unguarded `await` on a single account's patch. One
   * account erroring meant none of them ran, so a Core API blip while writing
   * one account's tier window left every stuck message stuck and every claimed
   * recipient held for another hour.
   */
  for (const account of accounts) {
    try {
      health.push(await checkAccount(account, now, stalenessHours, log));
    } catch (error) {
      count(METRIC.HEALTH_ACCOUNT_CHECK_FAILED);
      log.error('wa.health.account_check_failed', {
        accountId: account.id,
        ...describeError(error),
      });

      health.push({
        accountId: account.id,
        probe: 'failed',
        webhookStale: false,
        tierWindowRolled: false,
      });
    }
  }

  const stuck = await sweepStuckMessages(now);

  const staleClaims = await findStaleClaimedRecipients(
    new Date(now.getTime() - STALE_CLAIM_MS),
  );

  if (staleClaims.length > 0) {
    await patchRecipients(
      staleClaims.map((recipient) => recipient.id),
      { status: RECIPIENT_STATUS.PENDING, claimedAt: null },
    );
  }

  const failedEvents = await findFailedWebhookEvents();

  const result: HealthResult = {
    accounts: health,
    stuckRequeued: stuck.requeued,
    stuckFailed: stuck.failed,
    staleClaimsReleased: staleClaims.length,
    failedWebhookEvents: failedEvents.length,
  };

  log.info('wa.health.checked', {
    accounts: health.length,
    accountsInError: health.filter((entry) => entry.probe === 'failed').length,
    webhooksStale: health.filter((entry) => entry.webhookStale).length,
    stuckRequeued: result.stuckRequeued,
    stuckFailed: result.stuckFailed,
    staleClaimsReleased: result.staleClaimsReleased,
    failedWebhookEvents: result.failedWebhookEvents,
  });

  return result;
};

export const handler = async (): Promise<HealthResult> => {
  try {
    return await runHealthCheck();
  } catch (error) {
    logger.error('wa.health.failed', describeError(error));

    throw error;
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_HEALTH_CHECK,
  name: 'wa-health-check',
  description:
    'Hourly account probe, webhook liveness, tier window roll, stuck-message recovery and stale-claim release.',
  timeoutSeconds: 60,
  cronTriggerSettings: { pattern: '0 * * * *' },
  handler,
});
