import { defineLogicFunction } from 'twenty-sdk/define';
import {
  Response,
  kv,
  type RoutePayload,
  type ServerRouteResolverResult,
} from 'twenty-sdk/logic-function';

import {
  LF_WEBHOOK_INGEST,
  LF_WEBHOOK_RESOLVER,
} from '../constants/universal-identifiers';
import type { MetaWebhookBody } from '../domain/webhook/types';
import {
  META_SIGNATURE_HEADER,
  verifyIncomingSignature,
} from '../providers/whatsapp';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { decideVerification } from './wa-webhook-verify';

/**
 * The webhook front door (AR-6, SEC-2, D-3).
 *
 * Runs in the app-owner workspace and does exactly three things: authenticity,
 * routing, and speed. No record I/O, no Meta calls — NFR-P1 gives it under a
 * second at p95, and Meta retries anything slower, turning a slow handler into
 * a duplicate storm.
 *
 * The signature is verified over the **raw bytes as received**, before the
 * parsed body is trusted for anything. Re-serialising and hashing that would
 * fail on every message containing a Portuguese accent or an emoji, because
 * Meta escapes non-ASCII as `\uXXXX` and `JSON.stringify` does not.
 */

/**
 * Routing keys for a delivery, in preference order (specs/03 §2.2).
 *
 * The WABA fallback is not optional: `message_template_status_update` and
 * `account_update` carry no `phone_number_id` at all, so a phone-only resolver
 * would drop every template approval as unclaimed.
 */
export const routingKeys = (body: MetaWebhookBody): string[] => {
  const keys: string[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value?.metadata?.phone_number_id;

      if (typeof phoneNumberId === 'string' && phoneNumberId.length > 0) {
        keys.push(`wa:phone-number:${phoneNumberId}`);
      }
    }

    if (typeof entry.id === 'string' && entry.id.length > 0) {
      keys.push(`wa:waba:${entry.id}`);
    }
  }

  return [...new Set(keys)];
};

export const resolveWorkspaceId = async (
  body: MetaWebhookBody,
): Promise<string | null> => {
  for (const key of routingKeys(body)) {
    const workspaceId = await kv.get<string>(key, { scope: 'SERVER' });

    if (typeof workspaceId === 'string' && workspaceId.length > 0) return workspaceId;
  }

  return null;
};

export const handler = async (
  event: RoutePayload<MetaWebhookBody>,
): Promise<ServerRouteResolverResult> => {
  // The platform may route the GET handshake here as well as to the dedicated
  // route (probe P-1), so both paths answer it identically.
  if (event.requestContext?.http?.method === 'GET') {
    count(METRIC.WEBHOOK_VERIFY_ATTEMPT);

    const outcome = decideVerification(event.queryStringParameters ?? {});

    if (outcome.status === 200) count(METRIC.WEBHOOK_VERIFY_OK);
    else if (outcome.status === 403) count(METRIC.WEBHOOK_VERIFY_REJECTED);

    return new Response(outcome.body, {
      status: outcome.status,
      headers: { 'content-type': 'text/plain' },
    });
  }

  /**
   * Without the raw body there is nothing to verify against, and processing an
   * unverifiable delivery would accept anything anyone posted at the endpoint.
   * Throwing rather than returning 401 is deliberate: this is a deployment
   * fault, not a rejected request, and it must be loud.
   */
  if (typeof event.rawBody !== 'string') {
    throw new Error('rawBody not forwarded; cannot verify X-Hub-Signature-256');
  }

  if (
    !verifyIncomingSignature({
      rawBody: event.rawBody,
      header: event.headers?.[META_SIGNATURE_HEADER],
    })
  ) {
    count(METRIC.WEBHOOK_SIGNATURE_REJECTED);
    logger.warn('wa.webhook.signature_rejected', { fn: 'wa-webhook-resolver' });

    return new Response({ error: 'invalid signature' }, { status: 401 });
  }

  const body = event.body;

  if (
    body === null ||
    body.object !== 'whatsapp_business_account' ||
    !Array.isArray(body.entry)
  ) {
    return new Response({ ok: true, skipped: 'unrecognised payload' }, { status: 200 });
  }

  let workspaceId: string | null = null;

  try {
    workspaceId = await resolveWorkspaceId(body);
  } catch (error) {
    logger.error('wa.webhook.routing_failed', {
      fn: 'wa-webhook-resolver',
      ...describeError(error),
    });

    throw error;
  }

  /**
   * An unclaimed number is answered 200, not 404. Meta retries a non-2xx for
   * seven days, so refusing traffic for a number we do not host would earn a
   * week of retries for a delivery we will never want.
   */
  if (workspaceId === null) {
    count(METRIC.WEBHOOK_UNCLAIMED);
    logger.warn('wa.webhook.unclaimed', { fn: 'wa-webhook-resolver' });

    return new Response({ ok: true, skipped: 'unclaimed number' }, { status: 200 });
  }

  return {
    workspaceId,
    targetLogicFunctionUniversalIdentifier: LF_WEBHOOK_INGEST,
    payload: { body, receivedAt: new Date().toISOString() },
  };
};

export default defineLogicFunction({
  universalIdentifier: LF_WEBHOOK_RESOLVER,
  name: 'wa-webhook-resolver',
  description:
    'Verifies the Meta webhook signature and dispatches the delivery to the owning workspace.',
  timeoutSeconds: 15,
  serverRouteTriggerSettings: {
    forwardedRequestHeaders: [META_SIGNATURE_HEADER],
  },
  handler,
});
