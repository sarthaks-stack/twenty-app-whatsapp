import { nodesOf, query } from './base';

/**
 * `workspaceMember` — who, in this workspace, did something.
 *
 * Read-only and deliberately minimal. The app never creates or edits a member;
 * it only ever needs to turn the id stored on a record into a name a rep
 * recognises, which is why the field set is a name and nothing else. Pulling
 * `userEmail`, `avatarUrl` and the rest would put colleagues' contact details
 * into an envelope that goes to the browser on every poll, to render one line
 * of eight-point type.
 */

const MEMBER_FIELDS = {
  id: true,
  name: { firstName: true, lastName: true },
} as const;

export type WorkspaceMemberRecord = {
  id: string;
  name?: { firstName?: string | null; lastName?: string | null } | null;
};

/**
 * Caps the lookup, because the caller is a page of at most fifty messages.
 * A page cannot contain more distinct senders than it has rows, but the bound
 * is stated rather than assumed.
 */
export const MAX_MEMBER_LOOKUPS = 50;

/**
 * One query for a page's worth of senders.
 *
 * Looking each up separately would make a fifty-message page cost fifty Core
 * API calls on every poll — the same N+1 the quote resolution exists to avoid,
 * and on the same hot path (NFR-R2).
 */
export const findWorkspaceMembersByIds = async (
  ids: string[],
): Promise<WorkspaceMemberRecord[]> => {
  const wanted = [...new Set(ids)].slice(0, MAX_MEMBER_LOOKUPS);

  if (wanted.length === 0) return [];

  const result = await query(
    (client) =>
      client.query({
        workspaceMembers: {
          __args: { filter: { id: { in: wanted } }, first: wanted.length },
          edges: { node: MEMBER_FIELDS },
        },
      }),
    'workspaceMembers.findByIds',
  );

  return nodesOf<WorkspaceMemberRecord>(result.workspaceMembers);
};
