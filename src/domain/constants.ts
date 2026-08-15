/**
 * The stored value of every SELECT field in the data model.
 *
 * Twenty requires SELECT option values to be `UPPER_SNAKE_CASE` (specs/02 §13),
 * which is easy to get subtly wrong in a string literal scattered through
 * handlers. Everything server-side compares against these constants; front
 * components map them to localised copy, so the wire format is stated once here
 * and pt/en labels stay a UI concern.
 *
 * `as const` objects rather than `enum`: enums are not erasable syntax, so they
 * break Node's native type stripping used by the tools in `tools/`.
 */

export const THREAD_STATUS = {
  OPEN: 'OPEN',
  AWAITING_REPLY: 'AWAITING_REPLY',
  CLOSED: 'CLOSED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
} as const;
export type ThreadStatus = (typeof THREAD_STATUS)[keyof typeof THREAD_STATUS];

export const WINDOW_STATE = { OPEN: 'OPEN', EXPIRED: 'EXPIRED' } as const;
export type WindowState = (typeof WINDOW_STATE)[keyof typeof WINDOW_STATE];

export const WINDOW_KIND = {
  STANDARD: 'STANDARD',
  FREE_ENTRY_POINT: 'FREE_ENTRY_POINT',
} as const;
export type WindowKind = (typeof WINDOW_KIND)[keyof typeof WINDOW_KIND];

export const DIRECTION = { INBOUND: 'INBOUND', OUTBOUND: 'OUTBOUND' } as const;
export type Direction = (typeof DIRECTION)[keyof typeof DIRECTION];

export const MESSAGE_TYPE = {
  TEXT: 'TEXT',
  IMAGE: 'IMAGE',
  AUDIO: 'AUDIO',
  VIDEO: 'VIDEO',
  DOCUMENT: 'DOCUMENT',
  STICKER: 'STICKER',
  LOCATION: 'LOCATION',
  CONTACTS: 'CONTACTS',
  REACTION: 'REACTION',
  INTERACTIVE: 'INTERACTIVE',
  BUTTON_REPLY: 'BUTTON_REPLY',
  LIST_REPLY: 'LIST_REPLY',
  TEMPLATE: 'TEMPLATE',
  SYSTEM: 'SYSTEM',
  UNSUPPORTED: 'UNSUPPORTED',
} as const;
export type MessageType = (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE];

export const MESSAGE_STATUS = {
  QUEUED: 'QUEUED',
  ACCEPTED: 'ACCEPTED',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  PLAYED: 'PLAYED',
  FAILED: 'FAILED',
} as const;
export type MessageStatus = (typeof MESSAGE_STATUS)[keyof typeof MESSAGE_STATUS];

export const LANE = { INTERACTIVE: 'INTERACTIVE', CAMPAIGN: 'CAMPAIGN' } as const;
export type Lane = (typeof LANE)[keyof typeof LANE];

export const SOURCE_KIND = {
  AGENT: 'AGENT',
  WORKFLOW: 'WORKFLOW',
  CAMPAIGN: 'CAMPAIGN',
  SYSTEM: 'SYSTEM',
} as const;
export type SourceKind = (typeof SOURCE_KIND)[keyof typeof SOURCE_KIND];

export const TEMPLATE_CATEGORY = {
  MARKETING: 'MARKETING',
  UTILITY: 'UTILITY',
  AUTHENTICATION: 'AUTHENTICATION',
} as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORY)[keyof typeof TEMPLATE_CATEGORY];

export const TEMPLATE_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
  IN_APPEAL: 'IN_APPEAL',
} as const;
export type TemplateStatus = (typeof TEMPLATE_STATUS)[keyof typeof TEMPLATE_STATUS];

export const QUALITY = {
  GREEN: 'GREEN',
  YELLOW: 'YELLOW',
  RED: 'RED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type Quality = (typeof QUALITY)[keyof typeof QUALITY];

export const ACCOUNT_STATUS = {
  PENDING: 'PENDING',
  CONNECTED: 'CONNECTED',
  ERROR: 'ERROR',
  DISABLED: 'DISABLED',
} as const;
export type AccountStatus = (typeof ACCOUNT_STATUS)[keyof typeof ACCOUNT_STATUS];

export const CONSENT_STATUS = {
  OPTED_IN: 'OPTED_IN',
  OPTED_OUT: 'OPTED_OUT',
  UNKNOWN: 'UNKNOWN',
} as const;
export type ConsentStatus = (typeof CONSENT_STATUS)[keyof typeof CONSENT_STATUS];

export const CONSENT_METHOD = {
  KEYWORD: 'KEYWORD',
  MANUAL: 'MANUAL',
  IMPORT: 'IMPORT',
  WEB_FORM: 'WEB_FORM',
  IN_THREAD: 'IN_THREAD',
  API: 'API',
} as const;
export type ConsentMethod = (typeof CONSENT_METHOD)[keyof typeof CONSENT_METHOD];

export const CAMPAIGN_STATUS = {
  DRAFT: 'DRAFT',
  SNAPSHOTTING: 'SNAPSHOTTING',
  READY: 'READY',
  SCHEDULED: 'SCHEDULED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  TIER_WAITING: 'TIER_WAITING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUS)[keyof typeof CAMPAIGN_STATUS];

export const RECIPIENT_STATUS = {
  PENDING: 'PENDING',
  EXCLUDED: 'EXCLUDED',
  CLAIMED: 'CLAIMED',
  QUEUED: 'QUEUED',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  RESPONDED: 'RESPONDED',
} as const;
export type RecipientStatus = (typeof RECIPIENT_STATUS)[keyof typeof RECIPIENT_STATUS];

export const EXCLUSION_REASON = {
  OPTED_OUT: 'OPTED_OUT',
  NO_CONSENT: 'NO_CONSENT',
  INVALID_PHONE: 'INVALID_PHONE',
  DUPLICATE: 'DUPLICATE',
  MISSING_VARIABLES: 'MISSING_VARIABLES',
  BLOCKED: 'BLOCKED',
} as const;
export type ExclusionReason = (typeof EXCLUSION_REASON)[keyof typeof EXCLUSION_REASON];

export const MESSAGING_TIER = {
  TIER_250: 'TIER_250',
  TIER_1K: 'TIER_1K',
  TIER_2K: 'TIER_2K',
  TIER_10K: 'TIER_10K',
  TIER_100K: 'TIER_100K',
  TIER_UNLIMITED: 'TIER_UNLIMITED',
} as const;
export type MessagingTier = (typeof MESSAGING_TIER)[keyof typeof MESSAGING_TIER];

export const WEBHOOK_PROCESSING_STATUS = {
  RECEIVED: 'RECEIVED',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED',
  SKIPPED_DUPLICATE: 'SKIPPED_DUPLICATE',
  UNCLAIMED: 'UNCLAIMED',
} as const;
export type WebhookProcessingStatus =
  (typeof WEBHOOK_PROCESSING_STATUS)[keyof typeof WEBHOOK_PROCESSING_STATUS];
