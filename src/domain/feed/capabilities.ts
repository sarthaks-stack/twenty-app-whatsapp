import { LANE, TEMPLATE_STATUS } from '../constants';
import {
  evaluateSendPermission,
  type SendContext,
  type SendVerdict,
} from '../policy/send-permission';

/**
 * What this conversation can be sent, action by action (spec §"Capability matrix").
 *
 * The feed used to answer one `policy` verdict and one `canSend` boolean, which
 * was exactly enough for a composer with two buttons. A composer with eight
 * entries in a ＋ menu cannot work from that: "can I attach a file" and "can I
 * react" have different answers to the same closed window, and a UI that
 * inferred them would be re-implementing WhatsApp's rules in the browser —
 * the thing AR-17 exists to prevent.
 *
 * So the server answers each one. The route and the sender remain authoritative
 * and re-check immediately before the Meta call; a disabled menu item is a
 * courtesy, never a control (SEC-5).
 *
 * `reason` is a `DENIAL` code or `NO_PERMISSION`, never a sentence.
 */

export type Capability = { allowed: boolean; reason: string | null; warnings: string[] };

export type ThreadCapabilities = {
  text: Capability;
  template: Capability;
  media: Capability;
  reaction: Capability;
  interactive: Capability;
  location: Capability;
  contacts: Capability;
};

/** The caller has no agent role. Not a policy denial — a permissions one. */
export const NO_PERMISSION = 'NO_PERMISSION';

const toCapability = (verdict: SendVerdict): Capability => ({
  allowed: verdict.allowed,
  reason: verdict.allowed ? null : verdict.reason,
  warnings: verdict.warnings,
});

const denied = (reason: string): Capability => ({ allowed: false, reason, warnings: [] });

/**
 * Every free-form action shares one verdict.
 *
 * Meta gates media, reactions, locations, contact cards and session interactive
 * messages behind the same 24-hour service window as a text reply — they are
 * all "the business speaking freely". Splitting them into seven independent
 * evaluations would suggest a difference that does not exist and would drift
 * the moment one of them was updated alone.
 */
export const capabilitiesFor = ({
  context,
  canSend,
}: {
  context: SendContext;
  canSend: boolean;
}): ThreadCapabilities => {
  if (!canSend) {
    const no = denied(NO_PERMISSION);

    return {
      text: no,
      template: no,
      media: no,
      reaction: no,
      interactive: no,
      location: no,
      contacts: no,
    };
  }

  const freeform = toCapability(
    evaluateSendPermission({ kind: 'FREEFORM', lane: LANE.INTERACTIVE }, context),
  );

  /**
   * The template capability answers "may this thread be sent *a* template",
   * not "may it be sent this one" — the picker still names a specific template
   * and the route re-checks it. Evaluating with a synthetic usable template is
   * what isolates the thread-level rules (blocked, opted out, account down)
   * from `TEMPLATE_UNAVAILABLE`, which is a fact about a template and not about
   * the conversation.
   */
  const template = toCapability(
    evaluateSendPermission(
      { kind: 'TEMPLATE', lane: LANE.INTERACTIVE },
      {
        ...context,
        template: {
          status: TEMPLATE_STATUS.APPROVED,
          publishedToCrm: true,
          isUsableInCrm: true,
        },
      },
    ),
  );

  return {
    text: freeform,
    template,
    media: freeform,
    reaction: freeform,
    interactive: freeform,
    location: freeform,
    contacts: freeform,
  };
};
