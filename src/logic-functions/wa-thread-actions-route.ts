import { defineLogicFunction } from 'twenty-sdk/define';
import { Response, type RoutePayload } from 'twenty-sdk/logic-function';

import { LF_THREAD_ACTIONS_ROUTE } from '../constants/universal-identifiers';
import { THREAD_STATUS, type ThreadStatus } from '../domain/constants';
import { getProvider } from '../providers/whatsapp';
import { AUDIT_ACTION, audit } from '../server/audit';
import { authErrorResponse, requireCaller, requireRole } from '../server/auth';
import { config } from '../server/config';
import { describeError, logger } from '../server/logger';
import { TIMELINE_EVENT, THREAD_OBJECT_UID, writeTimelineActivity } from '../server/timeline';
import { findAccountById } from '../server/repositories/accounts';
import { findNewestInboundWamid } from '../server/repositories/messages';
import { findPersonById } from '../server/repositories/people';
import {
  findThreadById,
  patchThread,
  type ThreadPatch,
  type WhatsappThreadRecord,
} from '../server/repositories/threads';

/**
 * Everything a rep can do to a conversation that is not sending a message
 * (FR-THR-3, FR-CID-4, FR-CID-5, FR-OUT-8).
 *
 * These live behind one route rather than six because they share the whole
 * preamble — authorise, load the thread, audit the actor — and because the
 * set is small and closed. Each action is a switch arm, not a handler.
 */

export type ThreadAction =
  | 'assign'
  | 'close'
  | 'reopen'
  | 'block'
  | 'unblock'
  | 'link'
  | 'relink'
  | 'markRead'
  | 'snooze';

export type ThreadActionBody = {
  action?: ThreadAction;
  threadId?: string;
  /** `assign`: null unassigns. */
  assigneeId?: string | null;
  /** `link` / `relink`: null detaches the conversation from any Person. */
  personId?: string | null;
  /** `snooze`: ISO timestamp; null clears. */
  snoozedUntil?: string | null;
};

/**
 * `link` and `relink` are the same operation with different provenance, and
 * that difference is worth keeping: `link` resolves an ambiguous match a human
 * was asked about (FR-CID-5), `relink` overrides one the system already made
 * (FR-CID-4). The audit trail reads very differently for the two.
 */
export const isLinkAction = (action: ThreadAction): boolean =>
  action === 'link' || action === 'relink';

/**
 * Resolving an ambiguous match clears the review state; a re-link on a healthy
 * thread must not change its status at all — a rep fixing an attribution has
 * not reopened a conversation they had closed.
 */
export const statusAfterLink = (
  current: string | null | undefined,
  personId: string | null,
): ThreadStatus | null => {
  if (current !== THREAD_STATUS.NEEDS_REVIEW) return null;

  return personId === null ? null : THREAD_STATUS.OPEN;
};

const linkPatch = (
  thread: WhatsappThreadRecord,
  personId: string | null,
): ThreadPatch => {
  const status = statusAfterLink(thread.status, personId);

  return {
    personId,
    /**
     * The candidate list is cleared once a human has decided. Leaving it would
     * keep the disambiguation banner on screen after the question was
     * answered.
     */
    ...(thread.status === THREAD_STATUS.NEEDS_REVIEW ? { linkCandidates: null } : {}),
    ...(status === null ? {} : { status }),
  };
};

/**
 * Marks the conversation read on WhatsApp itself (FR-OUT-8).
 *
 * Deliberately **not** routed through the lane scheduler: a read receipt is not
 * a message, is not billed, and must not consume send capacity that a customer
 * reply is waiting on. It is also entirely optional — a failure here leaves the
 * local unread count correctly zeroed, and the customer simply does not see
 * blue ticks.
 */
const sendReadReceipt = async (thread: WhatsappThreadRecord): Promise<boolean> => {
  if (!config.sendReadReceipts()) return false;

  const account =
    typeof thread.accountId === 'string' ? await findAccountById(thread.accountId) : null;

  if (account === null || typeof account.phoneNumberId !== 'string') return false;

  const wamid = await findNewestInboundWamid(thread.id);
  if (wamid === null) return false;

  try {
    await getProvider().markAsRead({ phoneNumberId: account.phoneNumberId, wamid });

    return true;
  } catch (error) {
    logger.warn('wa.thread.read_receipt_failed', {
      correlationId: thread.id,
      ...describeError(error),
    });

    return false;
  }
};

export const handler = async (
  event: RoutePayload<ThreadActionBody>,
): Promise<Response> => {
  const log = logger.child({ fn: 'wa-thread-actions-route' });

  try {
    const caller = await requireCaller(event);
    requireRole(caller, 'agent');

    const body = event.body ?? {};
    const action = body.action;

    if (action === undefined) {
      return new Response({ error: 'action is required' }, { status: 400 });
    }

    if (typeof body.threadId !== 'string' || body.threadId.length === 0) {
      return new Response({ error: 'threadId is required' }, { status: 400 });
    }

    const thread = await findThreadById(body.threadId);

    if (thread === null) return new Response({ error: 'Unknown thread' }, { status: 404 });

    switch (action) {
      case 'assign': {
        const assigneeId = body.assigneeId ?? null;

        await patchThread(thread.id, { assigneeId });

        audit({
          action: AUDIT_ACTION.THREAD_ASSIGN,
          actorId: caller.workspaceMemberId,
          subject: { threadId: thread.id, personId: thread.personId ?? null },
          details: { from: thread.assigneeId ?? null, to: assigneeId },
        });

        await writeTimelineActivity({
          name: TIMELINE_EVENT.THREAD_ASSIGNED,
          happensAt: new Date(),
          properties: { assigneeId, previousAssigneeId: thread.assigneeId ?? null },
          targetPersonId: thread.personId ?? null,
          linkedRecordId: thread.id,
          linkedObjectUniversalIdentifier: THREAD_OBJECT_UID,
        });

        return new Response({ threadId: thread.id, assigneeId }, { status: 200 });
      }

      case 'close':
      case 'reopen': {
        /**
         * `CLOSED` is a CRM label and nothing more — it does not touch Meta,
         * the service window, or the ability to send. It exists so an inbox
         * filter can hide handled conversations, and any inbound message
         * reopens it regardless (FR-THR-2).
         */
        const status = action === 'close' ? THREAD_STATUS.CLOSED : THREAD_STATUS.OPEN;

        await patchThread(thread.id, { status });

        return new Response({ threadId: thread.id, status }, { status: 200 });
      }

      case 'block':
      case 'unblock': {
        const isBlocked = action === 'block';

        await patchThread(thread.id, { isBlocked });

        /**
         * Audited like assign and relink. Blocking is the strongest thing a rep
         * can do to a conversation — the policy gate refuses every send to a
         * blocked thread and the snapshot excludes it from campaigns — so
         * "who stopped us messaging this customer, and when?" must have an
         * answer that is not a log line (D-38).
         */
        audit({
          action: AUDIT_ACTION.THREAD_BLOCK,
          actorId: caller.workspaceMemberId,
          subject: { threadId: thread.id, personId: thread.personId ?? null },
          details: { from: thread.isBlocked === true, to: isBlocked },
        });

        log.info('wa.thread.block_changed', { correlationId: thread.id, isBlocked });

        return new Response({ threadId: thread.id, isBlocked }, { status: 200 });
      }

      case 'link':
      case 'relink': {
        const personId = body.personId ?? null;

        if (personId !== null && (await findPersonById(personId)) === null) {
          return new Response({ error: 'Unknown person' }, { status: 404 });
        }

        const previousPersonId = thread.personId ?? null;

        await patchThread(thread.id, linkPatch(thread, personId));

        audit({
          action: AUDIT_ACTION.THREAD_RELINK,
          actorId: caller.workspaceMemberId,
          subject: { threadId: thread.id, personId },
          details: { from: previousPersonId, to: personId, resolvedReview: thread.status === THREAD_STATUS.NEEDS_REVIEW },
        });

        /**
         * Written on **both** records. Someone looking at the Person a
         * conversation was moved away from needs to see where it went as much
         * as the new one needs to see where it came from.
         */
        for (const targetPersonId of [previousPersonId, personId]) {
          if (targetPersonId === null) continue;

          await writeTimelineActivity({
            name: TIMELINE_EVENT.THREAD_RELINKED,
            happensAt: new Date(),
            properties: { from: previousPersonId, to: personId, waId: thread.waId ?? null },
            targetPersonId,
            linkedRecordId: thread.id,
            linkedObjectUniversalIdentifier: THREAD_OBJECT_UID,
          });
        }

        /**
         * Campaign recipient rows are deliberately **not** rewritten: they
         * record who was targeted at snapshot time, and an audit that changed
         * retroactively would not be one (specs/05 §2.4).
         */
        return new Response({ threadId: thread.id, personId }, { status: 200 });
      }

      case 'markRead': {
        await patchThread(thread.id, { unreadCount: 0 });

        const receipt = await sendReadReceipt(thread);

        return new Response({ threadId: thread.id, receiptSent: receipt }, { status: 200 });
      }

      case 'snooze': {
        const snoozedUntil = body.snoozedUntil ?? null;

        await patchThread(thread.id, { snoozedUntil });

        return new Response({ threadId: thread.id, snoozedUntil }, { status: 200 });
      }

      default:
        return new Response({ error: `Unknown action: ${String(action)}` }, { status: 400 });
    }
  } catch (error) {
    const authFailure = authErrorResponse(error);

    if (authFailure !== null) {
      return new Response(authFailure.body, { status: authFailure.status });
    }

    log.error('wa.thread.route_failed', describeError(error));

    return new Response({ error: 'Internal error' }, { status: 500 });
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_THREAD_ACTIONS_ROUTE,
  name: 'wa-thread-actions-route',
  description:
    'Assign, close, block, re-link and mark-read actions on a WhatsApp conversation.',
  timeoutSeconds: 30,
  httpRouteTriggerSettings: {
    path: '/whatsapp/thread',
    httpMethod: 'POST',
    isAuthRequired: true,
    // The caller's own token, so `requireCaller` can ask the platform who they
    // are rather than guess from a `userWorkspaceId` nothing else joins on (D-53).
    forwardedRequestHeaders: ['authorization'],
  },
  handler,
});
