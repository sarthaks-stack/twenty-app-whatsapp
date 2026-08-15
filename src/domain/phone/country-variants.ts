/**
 * The three markets where a WhatsApp `wa_id` is not simply the E.164 number
 * without `+` (FR-CID-2).
 *
 * This is the sole source of variant knowledge: the contact matcher, the
 * campaign de-duplicator and outbound `to` resolution all call
 * `identityCandidates`. Getting it wrong does not throw — it silently fails to
 * match a real contact, or silently messages the wrong number.
 */

const BRAZIL = '55';
const ARGENTINA = '54';
const MEXICO = '52';

/**
 * Brazilian mobile numbers gained a 9th subscriber digit; WhatsApp may report
 * either form. `55` + 2-digit area + 8 or 9 digits.
 */
const brazilVariants = (digits: string): string[] => {
  const rest = digits.slice(BRAZIL.length);
  if (rest.length < 10) return [];

  const area = rest.slice(0, 2);
  const subscriber = rest.slice(2);

  if (subscriber.length === 9 && subscriber.startsWith('9')) {
    return [`${BRAZIL}${area}${subscriber.slice(1)}`];
  }
  if (subscriber.length === 8) {
    return [`${BRAZIL}${area}9${subscriber}`];
  }
  return [];
};

/**
 * Argentina requires a `9` between country code and area code for mobile
 * numbers dialled internationally; `wa_id` may omit it.
 */
const argentinaVariants = (digits: string): string[] => {
  const rest = digits.slice(ARGENTINA.length);
  if (rest.length < 8) return [];

  return rest.startsWith('9')
    ? [`${ARGENTINA}${rest.slice(1)}`]
    : [`${ARGENTINA}9${rest}`];
};

/**
 * Mexico's legacy `1` prefix after the country code still appears on older
 * records and on some `wa_id` values.
 */
const mexicoVariants = (digits: string): string[] => {
  const rest = digits.slice(MEXICO.length);
  if (rest.length < 10) return [];

  return rest.startsWith('1') ? [`${MEXICO}${rest.slice(1)}`] : [`${MEXICO}1${rest}`];
};

/**
 * Every digit-string that could legitimately denote the same subscriber,
 * including the input. Digits only, no `+`.
 */
export const digitVariants = (digits: string): string[] => {
  const variants = ((): string[] => {
    if (digits.startsWith(BRAZIL)) return brazilVariants(digits);
    if (digits.startsWith(ARGENTINA)) return argentinaVariants(digits);
    if (digits.startsWith(MEXICO)) return mexicoVariants(digits);
    return [];
  })();

  return [...new Set([digits, ...variants])];
};
