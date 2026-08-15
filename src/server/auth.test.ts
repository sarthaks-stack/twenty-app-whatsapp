import { describe, expect, it } from 'vitest';

import { ROLE_ADMIN, ROLE_AGENT } from '../constants/universal-identifiers';
import {
  ForbiddenError,
  UnauthorizedError,
  authErrorResponse,
  requireRole,
  type Caller,
} from './auth';
import {
  clearClaims,
  phoneClaimKey,
  wabaClaimKey,
} from '../logic-functions/wa-account-admin-route';

const caller = (overrides: Partial<Caller> = {}): Caller => ({
  userWorkspaceId: 'uw-1',
  workspaceMemberId: 'wm-1',
  roleUniversalIdentifiers: [],
  isAdmin: false,
  isAgent: false,
  isMachine: false,
  ...overrides,
});

describe('requireRole', () => {
  it('lets an admin through an admin gate', () => {
    expect(() =>
      requireRole(caller({ isAdmin: true, isAgent: true }), 'admin'),
    ).not.toThrow();
  });

  it('refuses an agent at an admin gate', () => {
    expect(() =>
      requireRole(caller({ isAgent: true, roleUniversalIdentifiers: [ROLE_AGENT] }), 'admin'),
    ).toThrow(ForbiddenError);
  });

  it('refuses someone with no role at all', () => {
    expect(() => requireRole(caller(), 'agent')).toThrow(ForbiddenError);
  });

  /** Admin implies agent: every admin can do everything a rep can. */
  it('lets an admin through an agent gate', () => {
    expect(() =>
      requireRole(caller({ isAdmin: true, isAgent: true, roleUniversalIdentifiers: [ROLE_ADMIN] }), 'agent'),
    ).not.toThrow();
  });

  it('names the required role without naming the caller', () => {
    try {
      requireRole(caller(), 'admin');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('admin');
      expect((error as Error).message).not.toContain('uw-1');
    }
  });
});

describe('authErrorResponse', () => {
  it('maps the two auth failures to their status codes', () => {
    expect(authErrorResponse(new UnauthorizedError())?.status).toBe(401);
    expect(authErrorResponse(new ForbiddenError())?.status).toBe(403);
  });

  /** Anything else is a bug, not a permission decision, and must not read as 403. */
  it('returns null for an unrelated error', () => {
    expect(authErrorResponse(new Error('database exploded'))).toBeNull();
  });
});

describe('routing claims', () => {
  it('keys both forms exactly as the resolver reads them', () => {
    expect(phoneClaimKey('1206450239224164')).toBe('wa:phone-number:1206450239224164');
    expect(wabaClaimKey('2129199877947066')).toBe('wa:waba:2129199877947066');
  });

  /**
   * Several numbers commonly share one WABA. Clearing the WABA claim on
   * disconnecting one of them would silently stop every *other* number's
   * template and account events — with nothing in the UI to suggest why.
   */
  it('keeps the WABA claim when another account still uses it', async () => {
    const deleted: string[] = [];
    const kvModule = await import('twenty-sdk/logic-function');
    const original = kvModule.kv.delete;

    kvModule.kv.delete = (async (key: string) => {
      deleted.push(key);

      return true;
    }) as typeof kvModule.kv.delete;

    try {
      await clearClaims({ phoneNumberId: 'pn-1', wabaId: 'waba-1', wabaStillInUse: true });
      expect(deleted).toEqual(['wa:phone-number:pn-1']);

      deleted.length = 0;
      await clearClaims({ phoneNumberId: 'pn-1', wabaId: 'waba-1', wabaStillInUse: false });
      expect(deleted).toEqual(['wa:phone-number:pn-1', 'wa:waba:waba-1']);
    } finally {
      kvModule.kv.delete = original;
    }
  });
});
