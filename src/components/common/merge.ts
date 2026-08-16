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
