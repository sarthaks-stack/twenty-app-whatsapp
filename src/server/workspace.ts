import { kv } from 'twenty-sdk/logic-function';

import { metadataClient } from './clients';

/**
 * The id of the workspace a logic function is running in.
 *
 * `RoutePayload` carries `userWorkspaceId` — the *membership* id — not the
 * workspace id, and the routing claim (D-3) must hold the latter: the webhook
 * resolver dispatches with it, so a membership id there would route every
 * delivery to nowhere. That distinction is easy to miss because both are UUIDs
 * and both have "workspace" in the name.
 *
 * Cached indefinitely: a workspace's id is the one thing about it that cannot
 * change.
 */

const CACHE_KEY = 'wa:workspace-id';

let memo: string | null = null;

export const currentWorkspaceId = async (): Promise<string | null> => {
  if (memo !== null) return memo;

  const cached = await kv.get<string>(CACHE_KEY, { scope: 'WORKSPACE' });

  if (typeof cached === 'string' && cached.length > 0) {
    memo = cached;

    return memo;
  }

  const result = await metadataClient().query({ currentWorkspace: { id: true } });
  const id = result.currentWorkspace?.id ?? null;

  if (typeof id !== 'string' || id.length === 0) return null;

  memo = id;
  await kv.set(CACHE_KEY, id, { scope: 'WORKSPACE' });

  return id;
};

/** Test seam. */
export const resetWorkspaceCache = (): void => {
  memo = null;
};
