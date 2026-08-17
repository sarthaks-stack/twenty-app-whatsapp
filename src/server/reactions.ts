import { asJson } from './repositories/base';
import { findMessageByWamid, patchMessage } from './repositories/messages';

/**
 * Where a reaction actually lands (spec §"Reaction UX").
 *
 * A reaction is stored twice on purpose: as its own message row, which is the
 * audit record and the thing a webhook redelivery de-duplicates against, and as
 * an entry on the *target* message's payload, which is what a bubble renders.
 * Only the second one is visible, and until now only the inbound path wrote it.
 *
 * That asymmetry was the bug the spec names: a rep's 👍 sent successfully,
 * Meta delivered it, the customer saw it — and our own transcript showed
 * nothing, because the only code that patched a target was the webhook handler.
 * Both paths call this now, so "the reaction appeared" cannot depend on who
 * reacted.
 *
 * One reaction per actor, replaced rather than appended: WhatsApp lets anyone
 * change their reaction, and appending would show one person reacting three
 * times with three different emoji. An empty emoji removes it — the same call,
 * because that is how Meta models a removal too.
 */

export type ReactionActor =
  | { kind: 'CONTACT'; waId: string; label?: string | null }
  | { kind: 'WORKSPACE_MEMBER'; workspaceMemberId: string; label?: string | null };

export type StoredReaction = {
  waId?: string;
  workspaceMemberId?: string;
  actorLabel?: string | null;
  emoji: string;
};

const identifies = (reaction: StoredReaction, actor: ReactionActor): boolean =>
  actor.kind === 'CONTACT'
    ? reaction.waId === actor.waId
    : reaction.workspaceMemberId === actor.workspaceMemberId;

const entryFor = (actor: ReactionActor, emoji: string): StoredReaction =>
  actor.kind === 'CONTACT'
    ? {
        waId: actor.waId,
        ...(actor.label === null || actor.label === undefined
          ? {}
          : { actorLabel: actor.label }),
        emoji,
      }
    : {
        workspaceMemberId: actor.workspaceMemberId,
        ...(actor.label === null || actor.label === undefined
          ? {}
          : { actorLabel: actor.label }),
        emoji,
      };

/**
 * The pure half: the new reaction list for a payload.
 *
 * Split out so the replace/remove rule can be tested without a database, which
 * is the half that actually has a wrong answer — the I/O below only has a
 * missing one.
 */
export const applyReactionToList = (
  existing: unknown,
  actor: ReactionActor,
  emoji: string,
): StoredReaction[] => {
  const current = Array.isArray(existing) ? (existing as StoredReaction[]) : [];
  const withoutActor = current.filter(
    (reaction) =>
      typeof reaction?.emoji === 'string' && !identifies(reaction, actor),
  );

  return emoji.length === 0 ? withoutActor : [...withoutActor, entryFor(actor, emoji)];
};

export type ReactionOutcome = 'patched' | 'target_missing';

export const applyReaction = async ({
  targetWamid,
  actor,
  emoji,
}: {
  targetWamid: string;
  actor: ReactionActor;
  emoji: string;
}): Promise<ReactionOutcome> => {
  const target = await findMessageByWamid(targetWamid);

  /**
   * Reacting to a message we never stored is normal for history that predates
   * the install, and for a customer scrolling far enough back. It is not an
   * error: the reaction row survives either way, and there is simply no bubble
   * to decorate.
   */
  if (target === null) return 'target_missing';

  const payload = asJson<Record<string, unknown>>(target.payload, {});

  await patchMessage(target.id, {
    payload: {
      ...payload,
      reactions: applyReactionToList(payload.reactions, actor, emoji),
    },
  });

  return 'patched';
};
