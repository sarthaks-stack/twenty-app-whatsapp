/**
 * The audience definition (FR-CAM-2).
 *
 * Three sources, one shape. What they share is `capturedAt`: the definition
 * records *when* the audience was chosen, and the recipient rows record who it
 * resolved to — so a campaign whose view changes the day after a launch still
 * answers "who did we send to, and on what basis" without reconstructing a
 * view that no longer exists (SEC-12).
 */

export const AUDIENCE_KIND = {
  VIEW: 'view',
  MESSAGE_LIST: 'messageList',
  MANUAL: 'manual',
} as const;
export type AudienceKind = (typeof AUDIENCE_KIND)[keyof typeof AUDIENCE_KIND];

export type AudienceDefinition =
  | { kind: 'view'; viewId: string; capturedAt: string }
  | { kind: 'messageList'; messageListId: string; capturedAt: string }
  | { kind: 'manual'; personIds: string[]; capturedAt: string };

/**
 * A manual audience is a literal list of ids stored on the campaign record, so
 * it is bounded by what a RAW_JSON column and a builder UI can carry. Larger
 * audiences belong in a view or a message list, which page.
 */
export const MAX_MANUAL_PERSON_IDS = 2_000;

export type AudienceParseResult =
  | { ok: true; definition: AudienceDefinition }
  | { ok: false; error: string };

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Parses a stored or submitted definition.
 *
 * Strict about the discriminant and about ids, because the failure it prevents
 * is a snapshot that silently produces nobody: an audience of zero looks
 * exactly like a filter that excluded everyone, and the two want opposite
 * responses from the admin.
 */
export const parseAudienceDefinition = (
  value: unknown,
  { now = new Date() }: { now?: Date } = {},
): AudienceParseResult => {
  if (value === null || typeof value !== 'object') {
    return { ok: false, error: 'audienceDefinition is required' };
  }

  const raw = value as Record<string, unknown>;
  const capturedAt = isNonEmptyString(raw.capturedAt)
    ? raw.capturedAt
    : now.toISOString();

  switch (raw.kind) {
    case AUDIENCE_KIND.VIEW:
      return isNonEmptyString(raw.viewId)
        ? { ok: true, definition: { kind: 'view', viewId: raw.viewId, capturedAt } }
        : { ok: false, error: 'a view audience needs viewId' };

    case AUDIENCE_KIND.MESSAGE_LIST:
      return isNonEmptyString(raw.messageListId)
        ? {
            ok: true,
            definition: {
              kind: 'messageList',
              messageListId: raw.messageListId,
              capturedAt,
            },
          }
        : { ok: false, error: 'a message-list audience needs messageListId' };

    case AUDIENCE_KIND.MANUAL: {
      const personIds = Array.isArray(raw.personIds)
        ? [...new Set(raw.personIds.filter(isNonEmptyString))]
        : [];

      if (personIds.length === 0) {
        return { ok: false, error: 'a manual audience needs at least one personId' };
      }

      if (personIds.length > MAX_MANUAL_PERSON_IDS) {
        return {
          ok: false,
          error: `a manual audience holds at most ${MAX_MANUAL_PERSON_IDS} people — use a view or a message list`,
        };
      }

      return { ok: true, definition: { kind: 'manual', personIds, capturedAt } };
    }

    default:
      return {
        ok: false,
        error: `audienceDefinition.kind must be one of ${Object.values(AUDIENCE_KIND).join(', ')}`,
      };
  }
};

/** How a definition reads in an audit line and in the pre-flight panel. */
export const describeAudience = (definition: AudienceDefinition): string => {
  switch (definition.kind) {
    case 'view':
      return `view ${definition.viewId}`;
    case 'messageList':
      return `message list ${definition.messageListId}`;
    case 'manual':
      return `${definition.personIds.length} manually selected people`;
  }
};

/**
 * The page cursor a snapshot carries between self-requeues.
 *
 * A view or list pages through the Core API's Relay cursor; a manual audience
 * pages by offset into its own id array. Keeping both in one type is what lets
 * the snapshot function have a single resume path rather than three.
 */
export type AudienceCursor = { kind: 'relay'; after: string } | { kind: 'offset'; at: number };

export const parseCursor = (value: unknown): AudienceCursor | null => {
  if (value === null || typeof value !== 'object') return null;

  const raw = value as Record<string, unknown>;

  if (raw.kind === 'relay' && isNonEmptyString(raw.after)) {
    return { kind: 'relay', after: raw.after };
  }

  if (raw.kind === 'offset' && typeof raw.at === 'number' && Number.isFinite(raw.at)) {
    return { kind: 'offset', at: Math.max(0, Math.trunc(raw.at)) };
  }

  return null;
};
