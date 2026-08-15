import {
  ACCOUNT_STATUS,
  CONSENT_STATUS,
  LANE,
  QUALITY,
  TEMPLATE_CATEGORY,
  TEMPLATE_STATUS,
  type AccountStatus,
  type ConsentStatus,
  type Lane,
  type Quality,
  type TemplateCategory,
  type TemplateStatus,
} from '../constants';
import { isWindowExpiringSoon, isWindowOpen } from './service-window';

/**
 * The policy gate (AR-17, AR-11).
 *
 * One pure function decides whether a send is allowed. The chat composer, the
 * HTTP route, the workflow action and the campaign runner all consume its
 * verdict; none of them re-implements a rule. The outbound sender re-runs it
 * immediately before the HTTP call, so a window that closed or an opt-out that
 * arrived while a message sat queued suppresses the send.
 *
 * Denials are machine codes, never prose: the front end owns pt/en copy
 * (specs/01 §7).
 */

export type SendIntentKind = 'FREEFORM' | 'TEMPLATE';

export type SendIntent = {
  kind: SendIntentKind;
  templateCategory?: TemplateCategory;
  lane: Lane;
};

export type SendContext = {
  now: Date;
  thread: {
    serviceWindowExpiresAt: Date | null;
    isBlocked: boolean;
  };
  person: { whatsappOptInStatus: ConsentStatus } | null;
  account: { status: AccountStatus; qualityRating: Quality };
  template?: {
    status: TemplateStatus;
    publishedToCrm: boolean;
    isUsableInCrm: boolean;
  };
};

export const DENIAL = {
  ACCOUNT_NOT_CONNECTED: 'ACCOUNT_NOT_CONNECTED',
  THREAD_BLOCKED: 'THREAD_BLOCKED',
  OPTED_OUT: 'OPTED_OUT',
  NO_CONSENT: 'NO_CONSENT',
  WINDOW_CLOSED: 'WINDOW_CLOSED',
  TEMPLATE_UNAVAILABLE: 'TEMPLATE_UNAVAILABLE',
  QUALITY_RED: 'QUALITY_RED',
} as const;
export type Denial = (typeof DENIAL)[keyof typeof DENIAL];

export const WARNING = {
  WINDOW_EXPIRING_SOON: 'WINDOW_EXPIRING_SOON',
  CONSENT_UNKNOWN_MARKETING: 'CONSENT_UNKNOWN_MARKETING',
  QUALITY_YELLOW: 'QUALITY_YELLOW',
} as const;
export type Warning = (typeof WARNING)[keyof typeof WARNING];

export type SendVerdict =
  | { allowed: true; warnings: Warning[] }
  | { allowed: false; reason: Denial; warnings: Warning[] };

const collectWarnings = (intent: SendIntent, context: SendContext): Warning[] => {
  const warnings: Warning[] = [];

  if (isWindowExpiringSoon(context.thread.serviceWindowExpiresAt, context.now)) {
    warnings.push(WARNING.WINDOW_EXPIRING_SOON);
  }
  if (context.account.qualityRating === QUALITY.YELLOW) {
    warnings.push(WARNING.QUALITY_YELLOW);
  }
  if (
    intent.templateCategory === TEMPLATE_CATEGORY.MARKETING &&
    context.person?.whatsappOptInStatus === CONSENT_STATUS.UNKNOWN
  ) {
    warnings.push(WARNING.CONSENT_UNKNOWN_MARKETING);
  }

  return warnings;
};

/**
 * Evaluation order is normative (specs/04 §1): the first failure wins, and
 * which reason surfaces matters. An opted-out contact whose window is also
 * closed reports `OPTED_OUT`, because that is the fact the rep must act on.
 */
export const evaluateSendPermission = (
  intent: SendIntent,
  context: SendContext,
): SendVerdict => {
  const warnings = collectWarnings(intent, context);
  const deny = (reason: Denial): SendVerdict => ({ allowed: false, reason, warnings });

  const windowOpen = isWindowOpen(context.thread.serviceWindowExpiresAt, context.now);
  const consent = context.person?.whatsappOptInStatus ?? CONSENT_STATUS.UNKNOWN;

  // 1. A number that is not connected cannot send at all — an invalid token or
  //    a restricted account pauses everything.
  if (context.account.status !== ACCOUNT_STATUS.CONNECTED) {
    return deny(DENIAL.ACCOUNT_NOT_CONNECTED);
  }

  // 2. Manual suppression, independent of consent.
  if (context.thread.isBlocked) return deny(DENIAL.THREAD_BLOCKED);

  // 3. Consent. A hard block for anything business-initiated, unoverridable by
  //    any role (FR-CON-2, SEC-6) — but a free-form reply inside an open window
  //    is still allowed, because the customer wrote to us and refusing to answer
  //    is neither helpful nor what opt-out means.
  if (consent === CONSENT_STATUS.OPTED_OUT) {
    const isCustomerInitiatedReply = intent.kind === 'FREEFORM' && windowOpen;
    if (!isCustomerInitiatedReply) return deny(DENIAL.OPTED_OUT);
  }

  // 4. Marketing to a contact who has not opted in. Denied outright for
  //    campaigns; a 1:1 send is a rep's judgement call and only warns.
  if (
    intent.templateCategory === TEMPLATE_CATEGORY.MARKETING &&
    consent !== CONSENT_STATUS.OPTED_IN &&
    intent.lane === LANE.CAMPAIGN
  ) {
    return deny(DENIAL.NO_CONSENT);
  }

  // 5. The window. Templates are exempt — that exemption is what makes
  //    FR-OUT-5 true: a rep can always reach a contact from the same thread.
  if (intent.kind === 'FREEFORM' && !windowOpen) return deny(DENIAL.WINDOW_CLOSED);

  // 6. Template state, re-checked server-side; the UI filter is convenience.
  if (intent.kind === 'TEMPLATE') {
    const template = context.template;
    const usable =
      template !== undefined &&
      template.status === TEMPLATE_STATUS.APPROVED &&
      template.publishedToCrm &&
      template.isUsableInCrm;

    if (!usable) return deny(DENIAL.TEMPLATE_UNAVAILABLE);
  }

  // 7. Quality gates campaigns only. Interactive sends are never blocked by
  //    quality — reps must still be able to answer customers on a RED number.
  if (intent.lane === LANE.CAMPAIGN && context.account.qualityRating === QUALITY.RED) {
    return deny(DENIAL.QUALITY_RED);
  }

  return { allowed: true, warnings };
};
