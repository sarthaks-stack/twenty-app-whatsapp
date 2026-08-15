import { defineLogicFunction } from 'twenty-sdk/define';
import { kv } from 'twenty-sdk/logic-function';

import { LF_STATUS_PROCESSOR } from '../constants/universal-identifiers';
import {
  MESSAGE_STATUS,
  RECIPIENT_STATUS,
  type MessageStatus,
  type RecipientStatus,
} from '../domain/constants';
import { advanceStatus } from '../domain/status-machine';
import { rateFor } from '../domain/campaign/guardrails';
import type { MetaError, MetaStatus } from '../domain/webhook/types';
import { ERROR_CLASS, MetaApiError, classify } from '../providers/whatsapp/errors';
import { config } from '../server/config';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { asJson } from '../server/repositories/base';
import {
  findRecipientsByMessageIds,
  patchRecipients,
} from '../server/repositories/campaign-recipients';
import { findMessagesByWamids, patchMessage } from '../server/repositories/messages';
import { markWebhookEvent, markWebhookEventFailed } from '../server/repositories/webhook-events';

/**
 * Outbound lifecycle from Meta's status webhooks (AR-9, FR-CAM-9, FR-CAM-10).
 *
 * **`read` may never arrive.** WhatsApp users can disable read receipts, and
 * when they do Meta emits `sent` and `delivered` and then silently nothing —
 * confirmed on the project test device 2026-08-15. So nothing here or
 * downstream may gate on `read`: it is recorded when it comes and its absence
 * means nothing at all.
 *
 * **Timestamps cannot order anything.** Also observed that day: three messages
 * produced six status events inside 1.3 s, with a `sent` and two `delivered`
 * for *different* messages all stamped `1786810070`. Ordering by
 * `status.timestamp` is impossible even in principle, which is why
 * `advanceStatus` ranks the status values and never compares times.
 */

export type StatusPayload = {
  webhookEventId?: string;
  accountId: string;
  statuses?: MetaStatus[];
  kind?: 'accountError';
  errors?: MetaError[];
};

export type StatusResult = {
  processed: number;
  orphans: number;
  advanced: number;
};

const META_TO_STATUS: Record<string, MessageStatus> = {
  sent: MESSAGE_STATUS.SENT,
  delivered: MESSAGE_STATUS.DELIVERED,
  read: MESSAGE_STATUS.READ,
  played: MESSAGE_STATUS.PLAYED,
  failed: MESSAGE_STATUS.FAILED,
};

const RECIPIENT_MIRROR: Partial<Record<MessageStatus, RecipientStatus>> = {
  [MESSAGE_STATUS.SENT]: RECIPIENT_STATUS.SENT,
  [MESSAGE_STATUS.DELIVERED]: RECIPIENT_STATUS.DELIVERED,
  [MESSAGE_STATUS.READ]: RECIPIENT_STATUS.READ,
  [MESSAGE_STATUS.PLAYED]: RECIPIENT_STATUS.READ,
  [MESSAGE_STATUS.FAILED]: RECIPIENT_STATUS.FAILED,
};

/** Campaign counter deltas, folded into the record by `wa-stats-rollup`. */
const campaignDeltaKey = (campaignId: string): string => `wa:campaign-delta:${campaignId}`;

/**
 * A status arriving before its own message is a legitimate race: Meta's webhook
 * can beat our own POST response. Within five minutes it is worth waiting for;
 * beyond that the message genuinely does not exist here and the status is an
 * orphan worth investigating.
 */
export const ORPHAN_GRACE_MS = 5 * 60_000;

export const isRecentEnoughToRetry = (
  status: MetaStatus,
  now: Date = new Date(),
): boolean => {
  const seconds = Number(status.timestamp);
  if (!Number.isFinite(seconds)) return true;

  return now.getTime() - seconds * 1000 < ORPHAN_GRACE_MS;
};

export const processStatuses = async (
  payload: StatusPayload,
): Promise<StatusResult> => {
  const log = logger.child({ fn: 'wa-status-processor', accountId: payload.accountId });

  if (payload.kind === 'accountError') {
    /**
     * An account-level `errors[]` block names no message. It is recorded on the
     * raw event and surfaced by the health panel; there is nothing per-message
     * to update.
     */
    log.warn('wa.status.account_error', {
      errorCode: payload.errors?.[0]?.code ?? null,
      errorDetail: payload.errors?.[0]?.title ?? null,
    });

    if (payload.webhookEventId !== undefined) {
      await markWebhookEvent(payload.webhookEventId, 'PROCESSED');
    }

    return { processed: 0, orphans: 0, advanced: 0 };
  }

  const statuses = payload.statuses ?? [];
  const wamids = [
    ...new Set(
      statuses
        .map((status) => status.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];

  // One query for the whole batch: 50 individual lookups per delivery would be
  // the entire Core API budget at campaign scale (NFR-R2).
  const messages = await findMessagesByWamids(wamids);

  const result: StatusResult = { processed: 0, orphans: 0, advanced: 0 };
  const recipientTransitions = new Map<RecipientStatus, string[]>();
  const campaignDeltas = new Map<string, Record<string, number>>();

  for (const status of statuses) {
    const wamid = status.id;
    if (typeof wamid !== 'string') continue;

    const message = wamid === undefined ? undefined : messages.get(wamid);

    if (message === undefined) {
      result.orphans += 1;
      count(METRIC.STATUS_ORPHAN);
      log.warn('wa.status.orphan', {
        correlationId: wamid,
        retryable: isRecentEnoughToRetry(status),
      });
      continue;
    }

    const incoming = META_TO_STATUS[status.status ?? ''];
    if (incoming === undefined) {
      log.debug('wa.status.unknown_value', { correlationId: wamid, value: status.status });
      continue;
    }

    result.processed += 1;
    count(METRIC.STATUS_PROCESSED);

    const current = (message.status ?? MESSAGE_STATUS.QUEUED) as MessageStatus;
    const next = advanceStatus(current, incoming);

    /**
     * Every observed transition is timestamped even when the status field does
     * not move (AR-9). A `failed` after `delivered` is ignored for the field —
     * the message *was* delivered — but Meta emits it on post-delivery policy
     * action, and losing that would leave the only evidence in a log line.
     */
    const statusTimestamps = {
      ...asJson<Record<string, unknown>>(message.statusTimestamps, {}),
      [incoming.toLowerCase()]: status.timestamp ?? null,
    };

    const patch: Parameters<typeof patchMessage>[1] = { statusTimestamps };

    if (next !== current) {
      patch.status = next;
      result.advanced += 1;
    } else if (incoming !== current) {
      count(METRIC.STATUS_DOWNGRADE_IGNORED);
    }

    if (incoming === MESSAGE_STATUS.FAILED) {
      const metaError = new MetaApiError(status.errors?.[0]?.title ?? 'Send failed', {
        code: status.errors?.[0]?.code,
        details: status.errors?.[0]?.error_data?.details ?? status.errors?.[0]?.message,
      });
      const classification = classify(metaError);

      patch.errorCode = metaError.code === null ? null : String(metaError.code);
      patch.errorDetail = metaError.details;

      count(
        classification.class === ERROR_CLASS.RETRYABLE_BACKOFF
          ? METRIC.STATUS_FAILED_RETRYABLE
          : METRIC.STATUS_FAILED_TERMINAL,
      );

      if (classification.unmapped) {
        log.warn('wa.send.unmapped_error', { correlationId: wamid, code: metaError.code });
      }
    }

    /**
     * Cost is attributed on `delivered`, using **Meta's own pricing category**
     * where it is present rather than our stored template category: Meta may
     * re-categorise a template silently, and its bill follows its own opinion,
     * not ours.
     */
    if (
      incoming === MESSAGE_STATUS.DELIVERED &&
      current !== MESSAGE_STATUS.DELIVERED &&
      status.pricing?.billable !== false
    ) {
      const category = (
        status.pricing?.category ??
        message.templateCategory ??
        ''
      ).toUpperCase();

      const rate = rateFor(
        category as Parameters<typeof rateFor>[0],
        config.rates(),
      );

      if (rate > 0) patch.billableCostUsd = rate;
    }

    await patchMessage(message.id, patch);

    const mirrored = RECIPIENT_MIRROR[incoming];

    if (mirrored !== undefined && next !== current) {
      const bucket = recipientTransitions.get(mirrored) ?? [];
      bucket.push(message.id);
      recipientTransitions.set(mirrored, bucket);
    }
  }

  await mirrorToRecipients(recipientTransitions, campaignDeltas);
  await writeCampaignDeltas(campaignDeltas);

  if (payload.webhookEventId !== undefined) {
    await markWebhookEvent(payload.webhookEventId, 'PROCESSED');
  }

  log.info('wa.status.batch', result);

  return result;
};

/**
 * Mirrors message statuses onto their campaign recipient rows (FR-CAM-9), one
 * bulk update per target status rather than one per recipient.
 */
const mirrorToRecipients = async (
  transitions: Map<RecipientStatus, string[]>,
  campaignDeltas: Map<string, Record<string, number>>,
): Promise<void> => {
  const allMessageIds = [...transitions.values()].flat();
  if (allMessageIds.length === 0) return;

  const recipients = await findRecipientsByMessageIds(allMessageIds);
  if (recipients.size === 0) return;

  for (const [status, messageIds] of transitions) {
    const ids = messageIds
      .map((messageId) => recipients.get(messageId))
      .filter((recipient) => recipient !== undefined)
      .map((recipient) => recipient.id);

    if (ids.length === 0) continue;

    await patchRecipients(ids, { status });

    for (const messageId of messageIds) {
      const campaignId = recipients.get(messageId)?.campaignId;
      if (typeof campaignId !== 'string') continue;

      const delta = campaignDeltas.get(campaignId) ?? {};
      const key = `${status.toLowerCase()}Count`;
      delta[key] = (delta[key] ?? 0) + 1;
      campaignDeltas.set(campaignId, delta);
    }
  }
};

/**
 * Campaign counters are **not** incremented per status.
 *
 * At campaign scale that would be one write per message per counter. Deltas go
 * to `kv` and `wa-stats-rollup` folds them into the record every 30 s — one
 * write per campaign per tick instead of one per message, which is what makes
 * "live stats ≤ 30 s p95" affordable (specs/03 §5.2).
 */
const writeCampaignDeltas = async (
  deltas: Map<string, Record<string, number>>,
): Promise<void> => {
  for (const [campaignId, delta] of deltas) {
    try {
      const key = campaignDeltaKey(campaignId);
      const current = (await kv.get<Record<string, number>>(key, { scope: 'WORKSPACE' })) ?? {};

      const merged = { ...current };
      for (const [field, value] of Object.entries(delta)) {
        merged[field] = (merged[field] ?? 0) + value;
      }

      await kv.set(key, merged, { scope: 'WORKSPACE' });
    } catch (error) {
      // Counters are approximate by construction; losing one must never fail
      // the status write that is the source of truth.
      logger.debug('wa.status.delta_write_failed', {
        campaignId,
        ...describeError(error),
      });
    }
  }
};

export const handler = async (payload: StatusPayload): Promise<StatusResult> => {
  try {
    return await processStatuses(payload);
  } catch (error) {
    if (payload.webhookEventId !== undefined) {
      await markWebhookEventFailed(
        payload.webhookEventId,
        0,
        error instanceof Error ? error.message : String(error),
      );
    }

    throw error;
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_STATUS_PROCESSOR,
  name: 'wa-status-processor',
  description:
    'Applies Meta delivery statuses to outbound messages and mirrors them onto campaign recipients.',
  timeoutSeconds: 30,
  handler,
});
