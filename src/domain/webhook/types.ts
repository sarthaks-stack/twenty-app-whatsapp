/**
 * Meta webhook payload shapes. Only the fields this app reads are modelled;
 * everything else survives in the stored raw payload.
 *
 * Reference: specs/appendix-a-meta-api.md §5.
 */

export type MetaProfile = { name?: string };

export type MetaContact = { profile?: MetaProfile; wa_id?: string };

export type MetaError = {
  code?: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
};

export type MetaReferral = {
  source_url?: string;
  source_type?: string;
  source_id?: string;
  headline?: string;
  body?: string;
};

export type MetaInteractive = {
  type?: 'button_reply' | 'list_reply' | 'nfm_reply' | string;
  button_reply?: { id?: string; title?: string };
  list_reply?: { id?: string; title?: string; description?: string };
  nfm_reply?: unknown;
};

export type MetaMessage = {
  from?: string;
  id?: string;
  /** Epoch seconds, as a string. */
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: MetaMediaPayload;
  video?: MetaMediaPayload;
  audio?: MetaMediaPayload & { voice?: boolean };
  document?: MetaMediaPayload & { filename?: string };
  sticker?: MetaMediaPayload & { animated?: boolean };
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
  };
  contacts?: unknown[];
  reaction?: { message_id?: string; emoji?: string };
  interactive?: MetaInteractive;
  button?: { payload?: string; text?: string };
  context?: { id?: string; from?: string; forwarded?: boolean };
  referral?: MetaReferral;
  errors?: MetaError[];
  order?: unknown;
  system?: { body?: string; type?: string };
};

export type MetaMediaPayload = {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  /**
   * Real deliveries inline a short-lived download URL that Meta's docs do not
   * mention (specs/03 §8). Observed 2026-08-15 on a voice note: a
   * `lookaside.fbsbx.com` link whose `ext` query parameter expired 301 s after
   * the message timestamp. It carries a `hash` access token, which is why the
   * capture harness strips it before a fixture is committed.
   */
  url?: string;
  file_size?: number | string;
};

export type MetaStatusValue =
  | 'sent'
  | 'delivered'
  | 'read'
  | 'played'
  | 'failed'
  | 'deleted';

export type MetaStatus = {
  id?: string;
  status?: MetaStatusValue | string;
  timestamp?: string;
  recipient_id?: string;
  conversation?: { id?: string; origin?: { type?: string } };
  pricing?: {
    billable?: boolean;
    category?: string;
    pricing_model?: string;
  };
  errors?: MetaError[];
};

export type MetaChangeValue = {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
  errors?: MetaError[];

  /**
   * message_template_status_update / _quality_update / _components_update.
   * Field names confirmed against Meta's own dashboard sample payloads
   * (captured 2026-08-15) rather than inferred from prose.
   */
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
  event?: string;
  reason?: string;
  /** Present on status updates — the authoritative signal for re-categorisation (FR-TPL-6). */
  message_template_category?: string;
  previous_quality_score?: string;
  new_quality_score?: string;
  /** components_update: the changed parts, not the whole component array. */
  message_template_title?: string;
  message_template_element?: string;
  message_template_footer?: string;
  message_template_buttons?: unknown[];

  /** phone_number_quality_update */
  display_phone_number?: string;
  current_limit?: string;
  old_limit?: string;
  max_daily_conversations_per_business?: number | string;

  /** account_update / account_review_update / phone_number_name_update */
  decision?: string;
  phone_number?: string;
  rejection_reason?: string;
  ban_info?: unknown;
  restriction_info?: unknown;
  requested_verified_name?: string;
};

export type MetaChange = { field?: string; value?: MetaChangeValue };

export type MetaEntry = { id?: string; changes?: MetaChange[] };

export type MetaWebhookBody = { object?: string; entry?: MetaEntry[] };
