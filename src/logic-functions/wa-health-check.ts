import { defineLogicFunction } from 'twenty-sdk/define';

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
import { INTERNAL_ERROR, MetaApiError } from '../providers/whatsapp/errors';
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

export type AccountHealth = {
  accountId: string;
  probe: 'ok' | 'failed' | 'skipped';
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

const probeAccount = async (
  account: WhatsappAccountRecord,
): Promise<'ok' | 'failed' | 'skipped'> => {
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

    return 'ok';
  } catch (error) {
    const detail =
      error instanceof MetaApiError
        ? `${error.code ?? error.httpStatus ?? 'error'}: ${error.details ?? error.message}`
        : String(error);

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

export const runHealthCheck = async (now: Date = new Date()): Promise<HealthResult> => {
  const log = logger.child({ fn: 'wa-health-check' });

  const accounts = await listAccounts([
    ACCOUNT_STATUS.CONNECTED,
    ACCOUNT_STATUS.ERROR,
    ACCOUNT_STATUS.PENDING,
  ]);

  const stalenessHours = config.webhookStalenessHours();
  const health: AccountHealth[] = [];

  for (const account of accounts) {
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

    health.push({ accountId: account.id, probe, webhookStale, tierWindowRolled });
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
