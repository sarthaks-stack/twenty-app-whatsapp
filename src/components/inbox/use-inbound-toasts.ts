import { useEffect, useRef } from 'react';
import { enqueueSnackbar } from 'twenty-sdk/front-component';

import type { ThreadProjection } from '../../domain/feed/projection';
import type { Translate } from '../common/copy';

/**
 * D-10 layer 2: a live toast for a message that just arrived.
 *
 * The platform has no notification entity and no push channel, so this is the
 * only thing that can interrupt a rep who is looking at Twenty but not at this
 * conversation. It reaches nobody who has the tab closed — layer 1 (the unread
 * badge) and layer 3 (a `whatsappMessage.created` workflow) cover that, and
 * pretending otherwise would be the failure mode of a notification system that
 * quietly does not notify.
 *
 * Its own module so the rule can be tested without a sandbox: `enqueueSnackbar`
 * is a host function, and everything interesting here is the decision about
 * *when* to call it.
 */

export const MAX_TOASTS_PER_TICK = 3;

export type ToastDecision = { threadId: string; name: string } | { count: number };

/**
 * Which threads have news, given what was last seen.
 *
 * Two rules earn their place:
 *
 * - **The first sight of a thread is never news.** A component that mounted
 *   into a page of forty conversations would otherwise fire forty toasts for
 *   messages that arrived while nobody was here. `seen` is seeded silently on
 *   the first tick, and only *increases* after that count.
 * - **A burst collapses.** Past three threads the individual toasts become a
 *   single count, because eleven stacked snackbars is not eleven notifications,
 *   it is a wall.
 */
export const decideToasts = (
  threads: ThreadProjection[],
  seen: Map<string, string>,
  { seeded }: { seeded: boolean },
): ToastDecision[] => {
  const fresh: ThreadProjection[] = [];

  for (const thread of threads) {
    const at = thread.lastInboundAt;

    if (typeof at !== 'string') continue;

    const previous = seen.get(thread.id);

    // Strictly later: an equal timestamp is the same message seen twice, which
    // every poll produces.
    if (seeded && (previous === undefined || at > previous)) fresh.push(thread);

    seen.set(thread.id, at);
  }

  if (fresh.length === 0) return [];

  if (fresh.length > MAX_TOASTS_PER_TICK) return [{ count: fresh.length }];

  return fresh.map((thread) => ({
    threadId: thread.id,
    name:
      thread.profileName ??
      (thread.person === null
        ? (thread.dialablePhone ?? thread.waId ?? '')
        : [thread.person.firstName, thread.person.lastName].filter(Boolean).join(' ')),
  }));
};

/**
 * Fires the toasts for one feed response.
 *
 * `threads` must be the `mine` filter: D-10 layer 2 is about *the current
 * user's* conversations, and a toast for someone else's is a distraction they
 * cannot act on.
 */
export const useInboundToasts = (
  threads: ThreadProjection[] | undefined,
  t: Translate,
): void => {
  const seen = useRef(new Map<string, string>());
  const seeded = useRef(false);

  useEffect(() => {
    if (threads === undefined) return;

    const decisions = decideToasts(threads, seen.current, { seeded: seeded.current });

    seeded.current = true;

    for (const decision of decisions) {
      void enqueueSnackbar(
        'count' in decision
          ? {
              message: t('toast.newMessages', { count: decision.count }),
              variant: 'info',
              dedupeKey: 'wa:inbound:many',
            }
          : {
              message: t('toast.newMessage', { name: decision.name }),
              variant: 'info',
              /**
               * Keyed by thread, so a conversation that receives three messages
               * while the rep is reading replaces its own toast instead of
               * stacking three.
               */
              dedupeKey: `wa:inbound:${decision.threadId}`,
            },
      );
    }
  }, [threads, t]);
};
