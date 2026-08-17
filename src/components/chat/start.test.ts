import { describe, expect, it } from 'vitest';

import { diagnoseStart } from './StartConversation';

/**
 * A contact with no conversation used to get one sentence in every situation.
 * These are the four screens that replaced it, and the order between them is
 * the part worth holding still: it follows the policy gate's own precedence
 * (specs/04 §1), because the first thing that blocks a send is the thing the
 * reader has to act on.
 */
describe('diagnoseStart', () => {
  it('reports the number before anything else — nothing works without it', () => {
    expect(diagnoseStart('ACCOUNT_NOT_CONNECTED', true).title).toBe('chat.setupTitle');

    // Even with no usable phone, the disconnected number is the real problem.
    expect(diagnoseStart('ACCOUNT_NOT_CONNECTED', false).title).toBe('chat.setupTitle');
  });

  it('reports consent for every shape of refusal', () => {
    for (const reason of ['OPTED_OUT', 'NO_CONSENT', 'THREAD_BLOCKED']) {
      expect(diagnoseStart(reason, true).title).toBe('chat.consentTitle');
    }
  });

  /** "This contact unsubscribed" outranks "this contact has no number". */
  it('prefers the consent story over the missing number', () => {
    expect(diagnoseStart('OPTED_OUT', false).title).toBe('chat.consentTitle');
  });

  it('reports a missing number when nothing else is wrong', () => {
    expect(diagnoseStart('WINDOW_CLOSED', false).title).toBe('chat.noPhoneTitle');
  });

  /**
   * The ordinary case. A first message to anybody is outside a window that has
   * never opened, so `WINDOW_CLOSED` here is not a refusal — it is the
   * instruction to open with a template (FR-OUT-5).
   */
  it('treats a closed window as the invitation to start, not as a block', () => {
    const diagnosis = diagnoseStart('WINDOW_CLOSED', true);

    expect(diagnosis.title).toBe('chat.noThread');
    expect(diagnosis.canStart).toBe(true);
  });

  it('treats an allowed policy the same way', () => {
    expect(diagnoseStart(null, true).canStart).toBe(true);
  });

  /** Only the ordinary case offers an action; the rest are somebody else's fix. */
  it('offers no action on any of the three blocked states', () => {
    expect(diagnoseStart('ACCOUNT_NOT_CONNECTED', true).canStart).toBe(false);
    expect(diagnoseStart('OPTED_OUT', true).canStart).toBe(false);
    expect(diagnoseStart('WINDOW_CLOSED', false).canStart).toBe(false);
  });

  /**
   * A denial this build has not met — a code from a policy rule added after it
   * shipped — must not fall through to "go ahead and message them". The rep
   * would compose a whole template and meet the refusal at the end.
   */
  it('does not offer to start on an unrecognised denial', () => {
    const diagnosis = diagnoseStart('SOMETHING_NEW', true);

    expect(diagnosis.canStart).toBe(false);
    expect(diagnosis.title).toBe('chat.blockedTitle');
  });
});
