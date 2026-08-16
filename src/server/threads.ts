import { THREAD_STATUS, WINDOW_KIND, WINDOW_STATE } from '../domain/constants';
import { waIdToE164 } from '../domain/phone/normalise';
import { isUniqueViolation } from './batching';
import { matchPerson, type LinkCandidate } from './matching';
import { logger } from './logger';
import type { WhatsappAccountRecord } from './repositories/accounts';
import { patchAccount } from './repositories/accounts';
import {
  createThread,
  findThread,
  patchThread,
  type WhatsappThreadRecord,
} from './repositories/threads';

/**
 * Thread lifecycle (FR-THR-1 … FR-THR-4).
 *
 * `upsertThread` is the single entry point for every path that can begin a
 * conversation — inbound, campaign send, workflow action, rep-initiated
 * template, side-panel "start a chat". That is the mechanical guarantee behind
 * FR-OUT-5, and the explicit avoidance of Chatwoot #14086, where a template
 * send created a second conversation alongside the existing one.
 */

export type UpsertThreadInput = {
  account: WhatsappAccountRecord;
  waId: string;
  profileName?: string | null;
  /** Inbound resolves identity; an outbound-initiated thread does not. */
  resolveIdentity?: boolean;
  /**
   * The contact this conversation is with, when the caller already knows.
   *
   * A campaign picked this person out of a CRM audience, so there is nothing to
   * resolve — and leaving it unset was a defect with two heads. The thread went
   * unlinked, so the conversation never appeared on the contact's record and a
   * reply went back through identity matching, which can create a *second*
   * Person for someone the campaign already had. Worse, the sender's policy
   * re-check reads consent through `thread.personId`: with no person it read
   * `UNKNOWN`, and an opt-out that arrived while a **utility** campaign message
   * sat in the queue would not have been caught. Found live — the denial came
   * back `NO_CONSENT` for someone who had explicitly opted out, which was the
   * thread saying it did not know who they were.
   */
  personId?: string | null;
  originCampaignId?: string | null;
};

export type UpsertThreadResult = {
  thread: WhatsappThreadRecord;
  created: boolean;
  matchKind?: 'matched' | 'created' | 'ambiguous' | 'unmatched';
};

/**
 * Round-robin assignment (FR-THR-4).
 *
 * The list is filtered against nothing here on purpose — an `ARRAY` of member
 * ids has no referential integrity (specs/05 §3.3), so a deactivated member can
 * still be picked. That is a visible, fixable state (the thread shows an
 * inactive assignee) rather than a silent one, and filtering would need a
 * workspace-member read on every new conversation.
 */
const nextAssignee = (
  account: WhatsappAccountRecord,
): { assigneeId: string; nextIndex: number } | null => {
  if (account.autoAssignStrategy !== 'ROUND_ROBIN') return null;

  const members = account.assignmentMemberIds ?? [];
  if (members.length === 0) return null;

  const nextIndex = ((account.lastAssignedIndex ?? 0) + 1) % members.length;

  return { assigneeId: members[nextIndex]!, nextIndex };
};

export const upsertThread = async ({
  account,
  waId,
  profileName,
  resolveIdentity = false,
  personId: knownPersonId = null,
  originCampaignId,
}: UpsertThreadInput): Promise<UpsertThreadResult> => {
  const existing = await findThread(account.id, waId);

  if (existing !== null) {
    const nameChanged =
      typeof profileName === 'string' &&
      profileName.length > 0 &&
      profileName !== existing.profileName;

    /**
     * An existing thread that nobody has linked gets linked. It is never
     * re-linked: an identity a human has already decided — or that inbound
     * matching resolved — outranks a caller's assumption, and silently moving a
     * conversation to a different contact is the one outcome worse than leaving
     * it unlinked.
     */
    const linking =
      knownPersonId !== null &&
      (existing.personId === null || existing.personId === undefined);

    if (nameChanged || linking) {
      const patch = {
        ...(nameChanged ? { profileName: profileName! } : {}),
        ...(linking ? { personId: knownPersonId } : {}),
      };

      await patchThread(existing.id, patch);

      return { thread: { ...existing, ...patch }, created: false };
    }

    return { thread: existing, created: false };
  }

  const match = resolveIdentity
    ? await matchPerson({ waId, account, profileName })
    : null;

  const personId =
    knownPersonId ??
    (match?.kind === 'matched' || match?.kind === 'created' ? match.person.id : null);

  const linkCandidates: LinkCandidate[] =
    match?.kind === 'ambiguous' ? match.candidates : [];

  const assignment = nextAssignee(account);

  try {
    const thread = await createThread({
      accountId: account.id,
      waId,
      dialablePhone: waIdToE164(waId),
      profileName: profileName ?? null,
      personId,
      assigneeId: assignment?.assigneeId ?? null,
      status:
        match?.kind === 'ambiguous' ? THREAD_STATUS.NEEDS_REVIEW : THREAD_STATUS.OPEN,
      windowState: WINDOW_STATE.EXPIRED,
      windowKind: WINDOW_KIND.STANDARD,
      ...(originCampaignId === undefined ? {} : { originCampaignId }),
      ...(linkCandidates.length === 0 ? {} : { linkCandidates: { candidates: linkCandidates } }),
    });

    if (assignment !== null) {
      await patchAccount(account.id, { lastAssignedIndex: assignment.nextIndex });
    }

    return { thread, created: true, matchKind: match?.kind };
  } catch (error) {
    /**
     * Two inbound messages from a new number can arrive at once. The unique
     * index on (accountId, waId) decides which create wins; the loser re-reads
     * and reuses the winner's thread, which is also what keeps the two from
     * creating two Persons (specs/05 §2.2).
     */
    if (!isUniqueViolation(error)) throw error;

    const raced = await findThread(account.id, waId);
    if (raced === null) throw error;

    logger.debug('threads.create_raced', { accountId: account.id, threadId: raced.id });

    return { thread: raced, created: false };
  }
};

/**
 * FR-THR-2: a new inbound always reopens. `CLOSED` is a CRM label with no
 * effect on Meta, the service window, or the ability to send — it exists so an
 * inbox filter can hide handled conversations, and a customer writing back
 * plainly un-handles one.
 *
 * `NEEDS_REVIEW` is *not* reopened: the ambiguity is unresolved regardless of
 * how many messages arrive, and downgrading it to `OPEN` would hide the banner
 * that asks a human to fix it.
 */
export const statusAfterInbound = (current: string | null | undefined): string =>
  current === THREAD_STATUS.NEEDS_REVIEW ? THREAD_STATUS.NEEDS_REVIEW : THREAD_STATUS.OPEN;
