import { WINDOW_KIND, WINDOW_STATE, type WindowKind, type WindowState } from '../constants';

/**
 * Customer service window arithmetic (FR-IN-3, FR-OUT-2, FR-IN-6).
 *
 * Everything here is UTC epoch milliseconds. No local time, no timezone
 * library, therefore no DST class of bug — display formatting in Africa/Luanda
 * happens only in front components.
 */

export type WindowConfig = {
  serviceWindowHours: number;
  fepWindowHours: number;
};

export const DEFAULT_WINDOW_CONFIG: WindowConfig = {
  serviceWindowHours: 24,
  fepWindowHours: 72,
};

const HOUR_MS = 3_600_000;

/**
 * A Click-to-WhatsApp conversation opens a 72-hour free window; an ordinary
 * inbound message opens 24 hours. The grace is tied to the referral
 * conversation, not to the contact forever — a later non-referral inbound
 * resets the kind to standard (specs/05 §3.5).
 */
export const computeWindowExpiry = (
  lastInboundAt: Date,
  kind: WindowKind,
  config: WindowConfig = DEFAULT_WINDOW_CONFIG,
): Date => {
  const hours =
    kind === WINDOW_KIND.FREE_ENTRY_POINT ? config.fepWindowHours : config.serviceWindowHours;

  return new Date(lastInboundAt.getTime() + hours * HOUR_MS);
};

/**
 * The authoritative check. Recomputed from `serviceWindowExpiresAt` on every
 * send decision — the denormalised `windowState` column is a filter cache that
 * a 15-minute sweeper refreshes, and the server never trusts it.
 */
export const isWindowOpen = (
  serviceWindowExpiresAt: Date | null | undefined,
  now: Date,
): boolean => {
  if (!(serviceWindowExpiresAt instanceof Date)) return false;

  return now.getTime() < serviceWindowExpiresAt.getTime();
};

export const windowStateFor = (
  serviceWindowExpiresAt: Date | null | undefined,
  now: Date,
): WindowState =>
  isWindowOpen(serviceWindowExpiresAt, now) ? WINDOW_STATE.OPEN : WINDOW_STATE.EXPIRED;

/** Milliseconds remaining, clamped at zero. Drives the composer countdown. */
export const windowRemainingMs = (
  serviceWindowExpiresAt: Date | null | undefined,
  now: Date,
): number => {
  if (!(serviceWindowExpiresAt instanceof Date)) return 0;

  return Math.max(0, serviceWindowExpiresAt.getTime() - now.getTime());
};

/** Under an hour left: the UI warns, because a reply now is free and later is not. */
export const isWindowExpiringSoon = (
  serviceWindowExpiresAt: Date | null | undefined,
  now: Date,
  thresholdMs = HOUR_MS,
): boolean => {
  const remaining = windowRemainingMs(serviceWindowExpiresAt, now);

  return remaining > 0 && remaining <= thresholdMs;
};
