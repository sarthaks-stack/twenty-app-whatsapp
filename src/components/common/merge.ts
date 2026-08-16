import type { MessageProjection } from '../../domain/feed/projection';

/**
 * Folding a delta into the list already on screen (specs/08 §2.1).
 *
 * Its own module so it can be tested without a sandbox: `use-feed` reaches for
 * the REST client and the host's application variables at import time, and this
 * is the only part of the polling loop with a wrong answer rather than a
 * missing one.
 *
 * Two rules:
 *
 * - **Key by `clientToken` when there is one.** An optimistic bubble and the
 *   server's record of the same send are the same message with different ids;
 *   keyed by id they would both render, and the rep would see their message
 *   twice.
 * - **Sort a delta, append a page.** A delta mixes brand-new messages with
 *   status changes to old ones and only the timestamps say where each belongs;
 *   an older page is already in order and re-sorting it would be work with no
 *   effect.
 */
export const mergeMessages = (
  existing: MessageProjection[],
  incoming: MessageProjection[],
  { append = false }: { append?: boolean } = {},
): MessageProjection[] => {
  if (incoming.length === 0) return existing;

  const keyOf = (message: MessageProjection): string =>
    message.clientToken === null || message.clientToken === undefined
      ? message.id
      : `token:${message.clientToken}`;

  const byKey = new Map<string, MessageProjection>();
  const order: string[] = [];

  const put = (message: MessageProjection): void => {
    const key = keyOf(message);

    if (!byKey.has(key)) order.push(key);

    byKey.set(key, message);
  };

  for (const message of existing) put(message);
  for (const message of incoming) put(message);

  if (append) return order.map((key) => byKey.get(key)!);

  return [...byKey.values()].sort((left, right) => {
    const a = left.createdAt ?? '';
    const b = right.createdAt ?? '';

    return a < b ? 1 : a > b ? -1 : 0;
  });
};

/**
 * Turns an optimistic bubble the server refused into a failed one.
 *
 * A refused send creates no row, so no delta will ever supersede the bubble by
 * `clientToken` — it would sit in the conversation saying "queued" for as long
 * as the tab stayed open, describing a message that was never sent. Marking it
 * failed is what makes the refusal visible where the message is, rather than
 * only in a banner the reader may have already dismissed.
 *
 * Only the local row is touched. `id.startsWith('local-')` is the guard: if a
 * server row for the same token has already arrived, the server's version of
 * events is the true one and a late error must not overwrite it.
 */
export const settleOptimisticMessages = (
  messages: MessageProjection[],
  clientToken: string,
  outcome: { error: string | null },
): MessageProjection[] =>
  messages.map((message) =>
    message.clientToken === clientToken && message.id.startsWith('local-')
      ? {
          ...message,
          status: 'FAILED',
          errorCode: null,
          errorDetail: outcome.error,
          /**
           * Retryable in the plain sense: the text is still there and "retry"
           * sends it again as a new message. It is not a claim that Meta said
           * it was retryable — nothing reached Meta.
           */
          isRetryable: message.body !== null,
        }
      : message,
  );
