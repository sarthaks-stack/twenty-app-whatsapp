import { defineLogicFunction } from 'twenty-sdk/define';

import {
  LF_ACCOUNT_EVENT,
  LF_INBOUND_PROCESSOR,
  LF_STATUS_PROCESSOR,
  LF_TEMPLATE_EVENT,
  LF_WEBHOOK_INGEST,
} from '../constants/universal-identifiers';
import { buildDedupKey } from '../domain/dedup-key';
import { classifyChange } from '../domain/webhook/classify-change';
import type { MetaChange, MetaEntry, MetaWebhookBody } from '../domain/webhook/types';
import { enqueueAll, type EnqueueInput } from '../server/jobs';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import {
  findAccountByPhoneNumberId,
  findAccountByWabaId,
  patchAccount,
  type WhatsappAccountRecord,
} from '../server/repositories/accounts';
import {
  markWebhookEvent,
  recordWebhookEvent,
} from '../server/repositories/webhook-events';

/**
 * The raw log and the fan-out (AR-7, D-2).
 *
 * Runs inside the resolved workspace. Its contract with the rest of the system:
 * **every change becomes a `whatsappWebhookEvent` row before anything is
 * processed** (NFR-R1). A processor that later fails leaves that row `FAILED`
 * with its error, replayable from the settings UI — nothing is ever silently
 * dropped, because Meta offers no replay API beyond its own 7-day retry.
 *
 * Ordering is not attempted. Meta guarantees none, so a `delivered` can be
 * processed before the `sent` that preceded it and even before the outbound
 * record exists. Both cases are handled by the status machine's monotonicity
 * and the orphan path, not by trying to sort a queue.
 */

/** How many statuses one `wa-status-processor` job handles (specs/03 §3). */
export const STATUS_BATCH_SIZE = 50;

export type IngestPayload = {
  body: MetaWebhookBody;
  receivedAt?: string;
};

export type IngestSummary = {
  changes: number;
  recorded: number;
  duplicates: number;
  foreign: number;
  unhandled: number;
  jobs: number;
};

const chunkStatuses = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

/**
 * Which processors a change needs (specs/03 §3).
 *
 * A single `messages` change can carry messages *and* statuses *and* errors at
 * once — which is the whole reason the fan-out lives here, inside the
 * workspace, rather than in the resolver.
 */
export const jobsForChange = ({
  change,
  webhookEventId,
  accountId,
  correlationId,
}: {
  change: MetaChange;
  webhookEventId: string;
  accountId: string;
  correlationId: string;
}): EnqueueInput[] => {
  const value = change.value ?? {};
  const field = change.field ?? 'unknown';
  const base = { webhookEventId, accountId };
  const jobs: EnqueueInput[] = [];

  // One job per message: they are independent, and a failure to process one
  // must not hold up the rest of a batch.
  for (const message of value.messages ?? []) {
    jobs.push({
      logicFunctionUniversalIdentifier: LF_INBOUND_PROCESSOR,
      payload: {
        ...base,
        message,
        contacts: value.contacts ?? [],
        metadata: value.metadata ?? {},
      },
      correlationId: message.id ?? correlationId,
    });
  }

  // Statuses batch: at campaign scale one job per status would cost more in
  // queue overhead than the work itself (NFR-R2).
  for (const batch of chunkStatuses(value.statuses ?? [], STATUS_BATCH_SIZE)) {
    jobs.push({
      logicFunctionUniversalIdentifier: LF_STATUS_PROCESSOR,
      payload: { ...base, statuses: batch },
      correlationId,
    });
  }

  if (
    (value.messages ?? []).length === 0 &&
    (value.statuses ?? []).length === 0 &&
    (value.errors ?? []).length > 0
  ) {
    jobs.push({
      logicFunctionUniversalIdentifier: LF_STATUS_PROCESSOR,
      payload: { ...base, kind: 'accountError', errors: value.errors },
      correlationId,
    });
  }

  if (field.startsWith('message_template_')) {
    jobs.push({
      logicFunctionUniversalIdentifier: LF_TEMPLATE_EVENT,
      payload: { ...base, field, value },
      correlationId,
    });
  }

  if (
    field === 'account_update' ||
    field === 'account_review_update' ||
    field === 'phone_number_quality_update' ||
    field === 'phone_number_name_update'
  ) {
    jobs.push({
      logicFunctionUniversalIdentifier: LF_ACCOUNT_EVENT,
      payload: { ...base, field, value },
      correlationId,
    });
  }

  return jobs;
};

/**
 * Which account a change belongs to — the number first, the WABA as fallback.
 *
 * Exported because the replay route has to answer the same question from a
 * *stored* change, and answering it differently there would be how a replayed
 * event lands in the wrong account or is refused as foreign.
 */
export const accountForChange = async (
  entry: MetaEntry,
  change: MetaChange,
): Promise<WhatsappAccountRecord | null> =>
  (await findAccountByPhoneNumberId(change.value?.metadata?.phone_number_id)) ??
  (await findAccountByWabaId(entry.id));

export const ingest = async (payload: IngestPayload): Promise<IngestSummary> => {
  const summary: IngestSummary = {
    changes: 0,
    recorded: 0,
    duplicates: 0,
    foreign: 0,
    unhandled: 0,
    jobs: 0,
  };

  const touchedAccounts = new Set<string>();
  const receivedAt = payload.receivedAt ?? new Date().toISOString();

  for (const entry of payload.body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      summary.changes += 1;

      const entryTime = (entry as { time?: number }).time;
      const dedupKey = buildDedupKey({ entryId: entry.id, entryTime, change });
      const log = logger.child({ fn: 'wa-webhook-ingest', correlationId: dedupKey });

      /**
       * A change whose number belongs to no account in *this* workspace is
       * another tenant's traffic. Processing it would be a data-isolation
       * defect, so the check is mandatory even though Meta scopes a delivery to
       * one app+WABA in practice (specs/03 §2.2).
       */
      const account = await accountForChange(entry, change);

      if (account === null) {
        summary.foreign += 1;
        count(METRIC.WEBHOOK_FOREIGN_ENTRY);
        log.error('wa.webhook.foreign_entry', { field: change.field });
        continue;
      }

      const result = await recordWebhookEvent({
        dedupKey,
        webhookField: change.field ?? 'unknown',
        payload: { ...change, _entryId: entry.id ?? null, _receivedAt: receivedAt },
      });

      // The unique index *is* the deduplication: a Meta redelivery collides
      // here and stops, with no read-then-write race to lose (D-12).
      if (!result.created) {
        summary.duplicates += 1;
        count(METRIC.WEBHOOK_DEDUP_HIT);
        log.debug('wa.webhook.dedup_hit');
        continue;
      }

      summary.recorded += 1;
      touchedAccounts.add(account.id);

      const jobs = jobsForChange({
        change,
        webhookEventId: result.event.id,
        accountId: account.id,
        correlationId: dedupKey,
      });

      if (jobs.length === 0) {
        summary.unhandled += 1;
        count(METRIC.WEBHOOK_UNHANDLED_FIELD);
        log.warn('wa.webhook.unhandled_field', { field: change.field });

        /**
         * Marked `PROCESSED` rather than `FAILED`: there is nothing to retry
         * and nothing wrong. The row and the counter are how a new Meta field
         * announces itself, and a `FAILED` row would put it in the replay
         * queue forever.
         */
        await markWebhookEvent(result.event.id, 'PROCESSED', 'unhandled field');
        continue;
      }

      summary.jobs += await enqueueAll(jobs);

      const classification = classifyChange(change);
      log.info('wa.webhook.ingested', {
        accountId: account.id,
        field: classification.field,
        kinds: classification.kinds,
        jobs: jobs.length,
      });
    }
  }

  /**
   * Liveness is coalesced to one write per account per delivery. A per-change
   * touch would double the write cost of every batched status delivery for a
   * field only the health panel reads (FR-ACC-2).
   */
  for (const accountId of touchedAccounts) {
    try {
      await patchAccount(accountId, { webhookLastEventAt: receivedAt });
    } catch (error) {
      logger.warn('wa.webhook.liveness_write_failed', {
        fn: 'wa-webhook-ingest',
        accountId,
        ...describeError(error),
      });
    }
  }

  return summary;
};

export const handler = async (payload: IngestPayload): Promise<IngestSummary> =>
  ingest(payload);

export default defineLogicFunction({
  universalIdentifier: LF_WEBHOOK_INGEST,
  name: 'wa-webhook-ingest',
  description:
    'Writes the raw webhook log and fans each change out to the processor that handles it.',
  timeoutSeconds: 30,
  handler,
});
