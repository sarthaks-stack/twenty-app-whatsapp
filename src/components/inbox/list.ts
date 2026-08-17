import type { ThreadProjection } from '../../domain/feed/projection';
import { displayPhone } from '../common/format';

/**
 * The list's own logic: what a row is called, and what a search matches.
 *
 * Pure and separate from the component because both questions have answers
 * that are easy to get quietly wrong — a thread with a person, a profile name
 * and neither are three different rows — and because a search that silently
 * fails to match a phone number is invisible until someone types one.
 */

/**
 * What to call a conversation.
 *
 * Precedence is deliberate and matches the header's: the WhatsApp profile name
 * is what the customer calls *themselves*, and it is what a rep recognises in a
 * list. The CRM's name for them is the fallback, and a bare number is the last
 * resort — never an empty row.
 */
export const threadName = (thread: ThreadProjection): string => {
  const person =
    thread.person === null
      ? ''
      : [thread.person.firstName, thread.person.lastName].filter(Boolean).join(' ');

  const profile = thread.profileName ?? '';

  return (
    (profile.length > 0 ? profile : person) ||
    displayPhone(thread.dialablePhone ?? thread.waId) ||
    displayPhone(thread.waId)
  );
};

/**
 * Everything about a thread that a typed *word* could reasonably mean.
 *
 * Deliberately no phone number. `threadName` falls back to one, so a nameless
 * conversation is still findable by its digits — but the number is otherwise
 * matched only through the branch below, which insists on three digits.
 * Including it here would let a bare "9" match every Angolan number in the
 * list, which is the same as the search doing nothing.
 */
const haystack = (thread: ThreadProjection): string =>
  [
    thread.profileName ?? '',
    thread.person === null
      ? ''
      : [thread.person.firstName, thread.person.lastName].filter(Boolean).join(' '),
    thread.lastMessagePreview ?? '',
  ].join(' ');

const phoneDigits = (thread: ThreadProjection): string =>
  (thread.dialablePhone ?? thread.waId ?? '').replace(/\D/g, '');

/**
 * Case- and accent-insensitive. "joao" must find "João": the market is
 * Portuguese-speaking (A-6), the names carry diacritics, and nobody types them
 * into a search box.
 */
const fold = (value: string): string =>
  value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export const matchesQuery = (thread: ThreadProjection, query: string): boolean => {
  const raw = query.trim();

  if (raw.length === 0) return true;
  if (fold(haystack(thread)).includes(fold(raw))) return true;

  /**
   * A number typed the way a person types it. The phone is displayed grouped —
   * "+244 923 456 789" — and searched ungrouped, so the spaces and the leading
   * plus are dropped from both sides before comparing. Three digits is the
   * floor: below it a stray "1" would match nearly every number in the list.
   */
  const digits = raw.replace(/\D/g, '');

  return digits.length >= 3 && phoneDigits(thread).includes(digits);
};

export const filterThreads = (
  threads: ThreadProjection[],
  query: string,
): ThreadProjection[] => threads.filter((thread) => matchesQuery(thread, query));

/**
 * Which row a keypress moves to (review §"keyboard shortcuts").
 *
 * Exported for the same reason `nextTabKey` is: it is the whole of the
 * keyboard model, and the ends are where it goes wrong. This one **clamps**
 * rather than wrapping — a list is not a tab strip, and jumping from the last
 * conversation back to the first is how a rep loses their place in a list of
 * fifty.
 */
export const nextThreadId = (
  ids: string[],
  current: string | null,
  direction: 1 | -1,
): string | null => {
  if (ids.length === 0) return null;

  const at = current === null ? -1 : ids.indexOf(current);

  // Nothing selected: down takes the first row, up takes the last.
  if (at === -1) return direction === 1 ? (ids[0] ?? null) : (ids[ids.length - 1] ?? null);

  const next = at + direction;

  return next < 0 || next >= ids.length ? current : (ids[next] ?? null);
};
