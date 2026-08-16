import type { Lang, Translate } from './copy';

/**
 * Dates, countdowns and sizes — in Africa/Luanda (FR-UI-5, specs/08 §8).
 *
 * The time zone is not the reader's browser. A rep in Lisbon looking at an
 * Angolan number's conversation must see the day boundary the *customer* is on,
 * or a message sent at 23:30 in Luanda files itself under tomorrow and the day
 * separators stop meaning anything. Same reasoning as the campaign quiet-hours
 * rule (D-44).
 */

export const CHAT_TIME_ZONE = 'Africa/Luanda';

const LOCALE: Record<Lang, string> = { pt: 'pt-PT', en: 'en-GB' };

const formatter = (lang: Lang, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(LOCALE[lang], { timeZone: CHAT_TIME_ZONE, ...options });

export const parseDate = (value: string | null | undefined): Date | null => {
  if (typeof value !== 'string' || value.length === 0) return null;

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** The time on a bubble: 14:07. */
export const clockTime = (value: string | null | undefined, lang: Lang): string => {
  const date = parseDate(value);

  return date === null
    ? ''
    : formatter(lang, { hour: '2-digit', minute: '2-digit' }).format(date);
};

/**
 * The calendar day in Luanda, as a comparable key — never a display string.
 *
 * Assembled from parts rather than formatted, because `format()` gives a
 * locale's *order* (17/08 here, 08/17 there) and a key whose shape depends on
 * the reader's language is one that stops comparing equal when the language
 * changes.
 */
export const dayKey = (value: string | null | undefined): string => {
  const date = parseDate(value);

  if (date === null) return '';

  const parts = formatter('en', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const of = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${of('year')}-${of('month')}-${of('day')}`;
};

/** The heading between two days of a conversation. */
export const daySeparator = (
  value: string | null | undefined,
  now: Date,
  lang: Lang,
  t: Translate,
): string => {
  const key = dayKey(value);

  if (key === '') return '';
  if (key === dayKey(now.toISOString())) return t('chat.today');

  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  if (key === dayKey(yesterday.toISOString())) return t('chat.yesterday');

  const date = parseDate(value)!;

  return formatter(lang, { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
};

/**
 * How long is left, as "5h 12m" (FR-UI-6).
 *
 * Truncated, not rounded: a window with 59 seconds left reads "1m" if rounded
 * up, and a rep who trusts that number sends a free-form message into a closed
 * window. Under a minute it says so.
 */
export const countdown = (
  expiresAt: string | null | undefined,
  now: Date,
): string | null => {
  const date = parseDate(expiresAt);

  if (date === null) return null;

  const remaining = date.getTime() - now.getTime();

  if (remaining <= 0) return null;

  const minutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;

  return '<1m';
};

/** "há 5 min" / "5 min ago" for an inbox row. */
export const relativeTime = (
  value: string | null | undefined,
  now: Date,
  lang: Lang,
): string => {
  const date = parseDate(value);

  if (date === null) return '';

  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const relative = new Intl.RelativeTimeFormat(LOCALE[lang], { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
  ];

  let amount = seconds;

  for (const [unit, size] of units) {
    if (Math.abs(amount) < size) return relative.format(Math.round(amount), unit);

    amount /= size;
  }

  return relative.format(Math.round(amount), 'year');
};

export const fileSize = (bytes: number | null | undefined): string => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';

  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

/** `+244 928 863 659` — grouped for reading, never for dialling. */
export const displayPhone = (value: string | null | undefined): string => {
  if (typeof value !== 'string' || value.length === 0) return '';

  const digits = value.replace(/[^\d+]/g, '');

  if (!digits.startsWith('+')) return value;

  const rest = digits.slice(1);
  const groups = rest.replace(/(\d{3})(?=\d)/g, '$1 ');

  return `+${groups}`;
};
