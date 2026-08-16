import {
  CONSENT_STATUS,
  EXCLUSION_REASON,
  TEMPLATE_CATEGORY,
  type ConsentStatus,
  type ExclusionReason,
  type TemplateCategory,
} from '../constants';
import { toE164 } from '../phone/normalise';

/**
 * The campaign audience exclusion matrix (FR-CAM-3, FR-CAM-5).
 *
 * Excluded recipients become rows rather than being dropped: that is what makes
 * the pre-flight breakdown auditable ("show me the 412 we skipped and why") and
 * what lets a later consent campaign pick them up.
 */

export type ExclusionCandidate = {
  personId: string;
  primaryPhone: string | null;
  additionalPhones?: string[];
  consent: ConsentStatus;
  threadIsBlocked?: boolean;
  /**
   * Every placeholder that resolved empty with no fallback (FR-CAM-4), named
   * the way `resolveParameters` names them: `{{1}}`, `header image`, `button 0`.
   *
   * Keys rather than body positions, because a template fails at Meta over a
   * header or a button URL just as surely as over `{{1}}` — and while this took
   * positions, those two gaps left the recipient *included*, to be rejected
   * one-by-one by Meta at send time instead of once, here, for free (D-26).
   */
  missingVariables?: string[];
};

export type ExclusionInput = {
  candidate: ExclusionCandidate;
  templateCategory: TemplateCategory;
  defaultCallingCode: string;
  /** Canonical numbers already accepted into this audience. */
  seenPhones: ReadonlySet<string>;
};

export type ExclusionDecision =
  | { excluded: false; phone: string }
  | { excluded: true; reason: ExclusionReason; phone: string | null };

/**
 * Order is normative — the first match wins and is what the recipient row
 * records. Consent precedes phone validity so the breakdown reports the
 * actionable fact: "we may not message them" rather than "their number looks
 * wrong".
 */
export const evaluateExclusion = ({
  candidate,
  templateCategory,
  defaultCallingCode,
  seenPhones,
}: ExclusionInput): ExclusionDecision => {
  const phone =
    toE164(candidate.primaryPhone, defaultCallingCode) ??
    (candidate.additionalPhones ?? [])
      .map((p) => toE164(p, defaultCallingCode))
      .find((p): p is string => p !== null) ??
    null;

  // 1. Opted out — never, for any category.
  if (candidate.consent === CONSENT_STATUS.OPTED_OUT) {
    return { excluded: true, reason: EXCLUSION_REASON.OPTED_OUT, phone };
  }

  // 2. Marketing requires an explicit opt-in, so `unknown` is excluded rather
  //    than warned (FR-CAM-5). Utility campaigns are transactional and need
  //    only the absence of an opt-out — the distinction that makes an
  //    operational bulk send possible at all.
  if (
    templateCategory === TEMPLATE_CATEGORY.MARKETING &&
    candidate.consent !== CONSENT_STATUS.OPTED_IN
  ) {
    return { excluded: true, reason: EXCLUSION_REASON.NO_CONSENT, phone };
  }

  // 3. No usable number.
  if (phone === null) {
    return { excluded: true, reason: EXCLUSION_REASON.INVALID_PHONE, phone: null };
  }

  // 4. First occurrence in scan order wins.
  if (seenPhones.has(phone)) {
    return { excluded: true, reason: EXCLUSION_REASON.DUPLICATE, phone };
  }

  // 5. Manual suppression on an existing conversation.
  if (candidate.threadIsBlocked === true) {
    return { excluded: true, reason: EXCLUSION_REASON.BLOCKED, phone };
  }

  // 6. A template we cannot fill for this person would fail at Meta anyway.
  if ((candidate.missingVariables ?? []).length > 0) {
    return { excluded: true, reason: EXCLUSION_REASON.MISSING_VARIABLES, phone };
  }

  return { excluded: false, phone };
};

export type ExclusionBreakdown = Record<ExclusionReason, number>;

export const emptyBreakdown = (): ExclusionBreakdown => ({
  [EXCLUSION_REASON.OPTED_OUT]: 0,
  [EXCLUSION_REASON.NO_CONSENT]: 0,
  [EXCLUSION_REASON.INVALID_PHONE]: 0,
  [EXCLUSION_REASON.DUPLICATE]: 0,
  [EXCLUSION_REASON.MISSING_VARIABLES]: 0,
  [EXCLUSION_REASON.BLOCKED]: 0,
});

export const tallyExclusion = (
  breakdown: ExclusionBreakdown,
  reason: ExclusionReason,
): ExclusionBreakdown => ({ ...breakdown, [reason]: breakdown[reason] + 1 });
