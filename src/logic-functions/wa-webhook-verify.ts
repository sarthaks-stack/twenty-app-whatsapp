import { defineLogicFunction } from 'twenty-sdk/define';
import { Response, type RoutePayload } from 'twenty-sdk/logic-function';

import { LF_WEBHOOK_VERIFY } from '../constants/universal-identifiers';
import { verifyIncomingToken } from '../providers/whatsapp';
import { logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';

/**
 * The GET half of Meta's webhook handshake (AR-6, D-1).
 *
 * Meta requires the **bare challenge string** as the response body — a
 * JSON-quoted body fails verification with no useful error, which is a
 * remarkably easy way to lose an afternoon. Hence `text/plain` and no
 * serialisation.
 *
 * Neither token is ever logged, and the comparison is constant-time: a length
 * or timing oracle on a verify token would let an attacker register their own
 * callback (SEC-2 §3).
 */

export type VerifyQuery = Record<string, string | undefined>;

export type VerifyOutcome =
  | { status: 200; body: string }
  | { status: 400 | 403; body: string };

/**
 * The decision, separated from the route so it can be tested without a server.
 *
 * `verify` is injectable for the same reason — the real check reads
 * `META_VERIFY_TOKEN` through the provider seam, which is what keeps the secret
 * out of every handler.
 */
export const decideVerification = (
  query: VerifyQuery,
  verify: (provided: string) => boolean = verifyIncomingToken,
): VerifyOutcome => {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (
    mode !== 'subscribe' ||
    typeof token !== 'string' ||
    token.length === 0 ||
    typeof challenge !== 'string' ||
    challenge.length === 0
  ) {
    return { status: 400, body: 'Bad Request' };
  }

  if (!verify(token)) {
    return { status: 403, body: 'Forbidden' };
  }

  return { status: 200, body: challenge };
};

export const handler = async (event: RoutePayload): Promise<Response> => {
  count(METRIC.WEBHOOK_VERIFY_ATTEMPT);

  const outcome = decideVerification(event.queryStringParameters ?? {});

  if (outcome.status === 200) {
    count(METRIC.WEBHOOK_VERIFY_OK);
    logger.info('wa.webhook.verify_ok', { fn: 'wa-webhook-verify' });
  } else {
    if (outcome.status === 403) count(METRIC.WEBHOOK_VERIFY_REJECTED);
    logger.warn('wa.webhook.verify_rejected', {
      fn: 'wa-webhook-verify',
      status: outcome.status,
    });
  }

  return new Response(outcome.body, {
    status: outcome.status,
    headers: { 'content-type': 'text/plain' },
  });
};

export default defineLogicFunction({
  universalIdentifier: LF_WEBHOOK_VERIFY,
  name: 'wa-webhook-verify',
  description: "Answers Meta's GET webhook verification handshake.",
  timeoutSeconds: 5,
  httpRouteTriggerSettings: {
    path: '/whatsapp/verify',
    httpMethod: 'GET',
    isAuthRequired: false,
  },
  handler,
});
