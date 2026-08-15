import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';

import { digitVariants } from './country-variants';

/**
 * Phone normalisation (FR-CID-1).
 *
 * Two directions that must never be conflated:
 *  - `toE164`   — a CRM-side value in any format → canonical `+…`
 *  - `waIdToE164` — Meta's `wa_id` (digits, no `+`) → canonical `+…`
 *
 * The thread stores Meta's exact `waId` **and** our canonical `dialablePhone`
 * separately, because for Argentina and Mexico they differ and sending to the
 * dialable form produces silent non-delivery (specs/04 §6).
 */

const digitsOf = (value: string): string => value.replace(/\D/g, '');

/** Turns `+244` / `244` / `00244` into a libphonenumber region, e.g. `AO`. */
const regionForCallingCode = (callingCode: string): CountryCode | undefined => {
  const digits = digitsOf(callingCode);
  if (digits.length === 0) return undefined;

  // parsePhoneNumberFromString needs a plausible national number to infer the
  // region; a country code plus filler digits is enough to read it back.
  const probe = parsePhoneNumberFromString(`+${digits}900000000`);
  return probe?.country;
};

/**
 * Any CRM-entered format → E.164 with `+`, or null when the value is not a
 * valid number. `defaultCallingCode` is applied only to nationally-formatted
 * input (no `+`, no international prefix).
 */
export const toE164 = (raw: string | null | undefined, defaultCallingCode = '+244'): string | null => {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const hasInternationalPrefix = trimmed.startsWith('+') || trimmed.startsWith('00');
  const normalisedInput = trimmed.startsWith('00') ? `+${digitsOf(trimmed).slice(2)}` : trimmed;

  const parsed = hasInternationalPrefix
    ? parsePhoneNumberFromString(normalisedInput)
    : parsePhoneNumberFromString(trimmed, regionForCallingCode(defaultCallingCode));

  return parsed?.isValid() === true ? parsed.number : null;
};

/**
 * Meta gives `wa_id` as bare digits. It is *usually* the E.164 number without
 * `+`, which is why this is a separate function: prefixing `+` and validating is
 * correct, but the variants below are what make matching actually work.
 */
export const waIdToE164 = (waId: string | null | undefined): string | null => {
  if (typeof waId !== 'string') return null;

  const digits = digitsOf(waId);
  if (digits.length < 6) return null;

  const parsed = parsePhoneNumberFromString(`+${digits}`);
  if (parsed?.isValid() === true) return parsed.number;

  // A wa_id that fails validation may still be a known country variant — the
  // Brazilian 8-digit form is invalid as dialled but is what Meta reports.
  for (const candidate of digitVariants(digits)) {
    const alt = parsePhoneNumberFromString(`+${candidate}`);
    if (alt?.isValid() === true) return alt.number;
  }

  return null;
};

/**
 * Every E.164 string that could denote the same subscriber, always including
 * the input. Used before declaring a number unknown (FR-CID-2).
 */
export const identityCandidates = (e164: string | null | undefined): string[] => {
  if (typeof e164 !== 'string' || e164.length === 0) return [];

  const digits = digitsOf(e164);
  if (digits.length < 6) return [];

  return digitVariants(digits).map((candidate) => `+${candidate}`);
};

/** The national portion, for matching against Twenty's PHONES composite. */
export const splitE164 = (
  e164: string,
): { callingCode: string; nationalNumber: string; countryCode: string } | null => {
  const parsed = parsePhoneNumberFromString(e164);
  if (parsed?.isValid() !== true) return null;

  return {
    callingCode: `+${parsed.countryCallingCode}`,
    nationalNumber: parsed.nationalNumber,
    countryCode: parsed.country ?? '',
  };
};

/** Meta expects `to` as digits with no `+`. */
export const toWaId = (e164: string): string => digitsOf(e164);
