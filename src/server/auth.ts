import { kv } from 'twenty-sdk/logic-function';

import { ROLE_ADMIN, ROLE_AGENT } from '../constants/universal-identifiers';
import { metadataClient } from './clients';
import { describeError, logger } from './logger';

/**
 * Server-side role re-checks (SEC-5).
 *
 * Object permissions protect the Core API. They do **not** protect our HTTP
 * routes, which run with the app's own role — so a route that trusted the
 * caller would let any authenticated agent connect a number or launch a
 * campaign. A front component hiding a button is a convenience, never a
 * control.
 */

export class UnauthorizedError extends Error {
  readonly status = 401;

  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;

  constructor(message = 'Insufficient permissions') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export type CallerRole = 'admin' | 'agent';

export type Caller = {
  /** Null for a machine caller — see `requireCaller`. */
  userWorkspaceId: string | null;
  workspaceMemberId: string | null;
  roleUniversalIdentifiers: string[];
  isAdmin: boolean;
  isAgent: boolean;
  /** An authenticated credential that is not a workspace member (an API key). */
  isMachine: boolean;
};

type RoleAssignment = {
  universalIdentifier: string | null;
  canUpdateAllSettings: boolean;
  members: { id: string; userWorkspaceId: string }[];
};

const ROLE_CACHE_KEY = 'wa:role-assignments';
const ROLE_CACHE_TTL_MS = 60_000;

type CachedRoles = { at: number; roles: RoleAssignment[] };

/**
 * Role assignments change rarely and every route needs them, so they are cached
 * for a minute. The TTL is short on purpose: revoking someone's admin role is a
 * security action, and waiting an hour for it to take effect would make the
 * cache the vulnerability.
 */
const loadRoleAssignments = async (): Promise<RoleAssignment[]> => {
  const cached = await kv.get<CachedRoles>(ROLE_CACHE_KEY, { scope: 'WORKSPACE' });

  if (cached !== null && Date.now() - cached.at < ROLE_CACHE_TTL_MS) return cached.roles;

  const result = await metadataClient().query({
    getRoles: {
      universalIdentifier: true,
      canUpdateAllSettings: true,
      workspaceMembers: { id: true, userWorkspaceId: true },
    },
  });

  const roles: RoleAssignment[] = (result.getRoles ?? []).map((role) => ({
    universalIdentifier: role.universalIdentifier ?? null,
    canUpdateAllSettings: role.canUpdateAllSettings === true,
    members: (role.workspaceMembers ?? [])
      .filter(
        (member): member is { id: string; userWorkspaceId: string } =>
          typeof member?.id === 'string' && typeof member?.userWorkspaceId === 'string',
      )
      .map((member) => ({ id: member.id, userWorkspaceId: member.userWorkspaceId })),
  }));

  await kv.set(ROLE_CACHE_KEY, { at: Date.now(), roles }, { scope: 'WORKSPACE' });

  return roles;
};

/** Forces the next check to re-read — call after changing a role assignment. */
export const invalidateRoleCache = async (): Promise<void> => {
  await kv.delete(ROLE_CACHE_KEY, { scope: 'WORKSPACE' });
};

export type AuthEvent = { userWorkspaceId?: string | null };

export const requireCaller = async (event: AuthEvent): Promise<Caller> => {
  const userWorkspaceId = event.userWorkspaceId;

  /**
   * No membership on an `isAuthRequired: true` route means a **machine
   * caller**, not an anonymous one.
   *
   * Verified against the running platform: an absent or invalid token is
   * rejected before the handler is entered ("Missing authentication token" /
   * "Token invalid."). So reaching this line without a membership means a valid
   * workspace-level credential — an API key.
   *
   * Such a key is granted admin authority here because refusing it would not be
   * a control. An API key can already create and modify any record through the
   * Core API directly; the thing this route uniquely owns is the `kv` routing
   * claim, and blocking it would only make automated setup impossible while
   * leaving the record writable anyway. What SEC-5 actually defends against is
   * a *logged-in agent* calling an admin route, and that case still fails.
   *
   * Machine actions are audited with a null actor, so "who connected this
   * number" reads "an API key" rather than a member's name.
   */
  if (typeof userWorkspaceId !== 'string' || userWorkspaceId.length === 0) {
    logger.info('auth.machine_caller');

    return {
      userWorkspaceId: null,
      workspaceMemberId: null,
      roleUniversalIdentifiers: [],
      isAdmin: true,
      isAgent: true,
      isMachine: true,
    };
  }

  let roles: RoleAssignment[];

  try {
    roles = await loadRoleAssignments();
  } catch (error) {
    /**
     * Fails closed. If the role map cannot be read we cannot tell an admin from
     * an agent, and guessing in the permissive direction on a route that
     * connects phone numbers is not a trade worth making.
     */
    logger.error('auth.role_lookup_failed', describeError(error));

    throw new ForbiddenError('Could not verify permissions');
  }

  const mine = roles.filter((role) =>
    role.members.some((member) => member.userWorkspaceId === userWorkspaceId),
  );

  const workspaceMemberId =
    mine
      .flatMap((role) => role.members)
      .find((member) => member.userWorkspaceId === userWorkspaceId)?.id ?? null;

  const identifiers = mine
    .map((role) => role.universalIdentifier)
    .filter((identifier): identifier is string => identifier !== null);

  /**
   * A Twenty workspace administrator counts as a WhatsApp admin.
   *
   * Without this the first connection is impossible: the app ships its roles
   * but assigns them to nobody, so a fresh install would have no one able to
   * connect a number — including the person who installed it. `canUpdateAllSettings`
   * is Twenty's own "may configure this workspace" flag, which is exactly the
   * authority this route needs.
   */
  const isWorkspaceAdmin = mine.some((role) => role.canUpdateAllSettings);
  const isAdmin = identifiers.includes(ROLE_ADMIN) || isWorkspaceAdmin;

  return {
    userWorkspaceId,
    workspaceMemberId,
    roleUniversalIdentifiers: identifiers,
    isAdmin,
    // Admin implies agent: every admin can also do everything a rep can.
    isAgent: isAdmin || identifiers.includes(ROLE_AGENT),
    isMachine: false,
  };
};

export const requireRole = (caller: Caller, role: CallerRole): void => {
  const permitted = role === 'admin' ? caller.isAdmin : caller.isAgent;

  if (!permitted) {
    logger.warn('auth.forbidden', {
      required: role,
      roles: caller.roleUniversalIdentifiers,
    });

    throw new ForbiddenError(`This action requires the WhatsApp ${role} role`);
  }
};

/**
 * Turns an auth failure into the response shape a route returns, so every route
 * reports the same thing for the same reason.
 */
export const authErrorResponse = (
  error: unknown,
): { status: number; body: { error: string } } | null => {
  if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
    return { status: error.status, body: { error: error.message } };
  }

  return null;
};
