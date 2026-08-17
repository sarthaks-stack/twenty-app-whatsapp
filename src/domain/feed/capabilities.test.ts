import { describe, expect, it } from 'vitest';

import { ACCOUNT_STATUS, CONSENT_STATUS, QUALITY } from '../constants';
import type { SendContext } from '../policy/send-permission';
import { NO_PERMISSION, capabilitiesFor } from './capabilities';

const NOW = new Date('2026-08-17T10:00:00Z');
const OPEN = new Date('2026-08-17T20:00:00Z');
const CLOSED = new Date('2026-08-16T20:00:00Z');

const context = (overrides: Partial<SendContext> = {}): SendContext => ({
  now: NOW,
  thread: { serviceWindowExpiresAt: OPEN, isBlocked: false },
  person: { whatsappOptInStatus: CONSENT_STATUS.OPTED_IN },
  account: { status: ACCOUNT_STATUS.CONNECTED, qualityRating: QUALITY.GREEN },
  ...overrides,
});

describe('capabilitiesFor', () => {
  it('opens every action inside an open window', () => {
    const capabilities = capabilitiesFor({ context: context(), canSend: true });

    expect(
      Object.values(capabilities).every((capability) => capability.allowed),
    ).toBe(true);
  });

  /**
   * The instruction, not the refusal: a closed window leaves exactly one way to
   * reach the contact, and the ＋ menu has to know which one (FR-OUT-5).
   */
  it('leaves only the template path open once the window has closed', () => {
    const capabilities = capabilitiesFor({
      context: context({ thread: { serviceWindowExpiresAt: CLOSED, isBlocked: false } }),
      canSend: true,
    });

    expect(capabilities.template.allowed).toBe(true);
    expect(capabilities.text).toEqual({
      allowed: false,
      reason: 'WINDOW_CLOSED',
      warnings: [],
    });
    // Media, reactions, locations and interactive messages are all "the
    // business speaking freely" and share the window rule.
    expect(capabilities.media.reason).toBe('WINDOW_CLOSED');
    expect(capabilities.reaction.reason).toBe('WINDOW_CLOSED');
    expect(capabilities.interactive.reason).toBe('WINDOW_CLOSED');
    expect(capabilities.location.reason).toBe('WINDOW_CLOSED');
    expect(capabilities.contacts.reason).toBe('WINDOW_CLOSED');
  });

  it('closes the template path too when the thread itself is blocked', () => {
    const capabilities = capabilitiesFor({
      context: context({ thread: { serviceWindowExpiresAt: OPEN, isBlocked: true } }),
      canSend: true,
    });

    expect(capabilities.template.reason).toBe('THREAD_BLOCKED');
    expect(capabilities.text.reason).toBe('THREAD_BLOCKED');
  });

  /**
   * The template capability answers "may this thread be sent *a* template" —
   * a fact about the conversation. Whether a specific template is approved is a
   * fact about that template, and the picker plus the route own it.
   */
  it('does not report TEMPLATE_UNAVAILABLE for a thread with no template chosen', () => {
    expect(capabilitiesFor({ context: context(), canSend: true }).template.reason).toBeNull();
  });

  it('reports a missing role as a permissions problem, not a policy one', () => {
    const capabilities = capabilitiesFor({ context: context(), canSend: false });

    expect(capabilities.text).toEqual({
      allowed: false,
      reason: NO_PERMISSION,
      warnings: [],
    });
    expect(capabilities.template.allowed).toBe(false);
  });

  it('carries warnings alongside an allowed action rather than instead of it', () => {
    const capabilities = capabilitiesFor({
      context: context({
        account: { status: ACCOUNT_STATUS.CONNECTED, qualityRating: QUALITY.YELLOW },
      }),
      canSend: true,
    });

    expect(capabilities.text.allowed).toBe(true);
    expect(capabilities.text.warnings).toContain('QUALITY_YELLOW');
  });
});
