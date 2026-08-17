import type { MessageProjection } from '../../domain/feed/projection';

/**
 * Which bubbles belong together (spec §"Layout rules").
 *
 * Six replies typed in a row are one turn in the conversation, and drawing each
 * with its own sender name, its own timestamp and a full gap between them makes
 * a burst look like six separate events. Grouping is what turns a transcript
 * back into speech.
 *
 * Pure, and separate from the list, because it is the one part of the layout
 * with a *wrong* answer rather than an ugly one — a group that spans a day
 * boundary, or one that silently merges a rep's message with an automation's,
 * misattributes what someone said.
 */

/** WhatsApp's own feel: a pause longer than this reads as a new turn. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type Grouping = {
  /** The oldest message of its group: carries the sender label above it. */
  startsGroup: boolean;
  /** The newest message of its group: carries the time and delivery state below it. */
  endsGroup: boolean;
};

const stampOf = (message: MessageProjection): number => {
  const raw = message.waTimestamp ?? message.createdAt;
  const parsed = raw === null ? Number.NaN : Date.parse(raw);

  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Whether two adjacent messages are the same turn.
 *
 * Direction is the obvious half. `sentById` is the half that matters in a busy
 * workspace: two reps answering the same conversation within a minute are two
 * people, and merging them under one avatar attributes one rep's words to the
 * other. `sourceKind` separates an automation's message from a human's for the
 * same reason.
 *
 * A failed message never groups. Its error sentence is the most important line
 * in the conversation, and a failure that inherited the group's silence would
 * lose the one timestamp that says *when* it failed.
 */
export const sameTurn = (
  newer: MessageProjection,
  older: MessageProjection,
): boolean => {
  if (newer.direction !== older.direction) return false;
  if (newer.sentById !== older.sentById) return false;
  if (newer.sourceKind !== older.sourceKind) return false;
  if (newer.lane !== older.lane) return false;
  if (newer.status === 'FAILED' || older.status === 'FAILED') return false;

  /**
   * A quoted reply always opens its own group: the quote strip is a heading
   * for the message under it, and a strip half-way down a group reads as
   * belonging to the whole run.
   */
  if (newer.quote !== null) return false;

  const gap = stampOf(newer) - stampOf(older);

  return gap >= 0 && gap <= GROUP_WINDOW_MS;
};

/**
 * Grouping flags for a newest-first list.
 *
 * The array is stored newest-first because the transcript renders into a
 * `column-reverse` container — see `MessageList`. So the *previous* index is
 * the visually lower, newer message, and the *next* index is the older one
 * above it. Getting that backwards puts every timestamp on the wrong bubble,
 * which is why it is written down rather than inferred at the call site.
 */
export const groupMessages = (
  messages: MessageProjection[],
  /** Day separators break a group even inside five minutes. */
  separators: ReadonlySet<string> = new Set(),
): Map<string, Grouping> => {
  const flags = new Map<string, Grouping>();

  messages.forEach((message, index) => {
    const newer = messages[index - 1];
    const older = messages[index + 1];

    flags.set(message.id, {
      startsGroup:
        older === undefined || separators.has(message.id) || !sameTurn(message, older),
      endsGroup:
        newer === undefined || separators.has(newer.id) || !sameTurn(newer, message),
    });
  });

  return flags;
};
