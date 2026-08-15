import { getFieldUniversalIdentifier, STANDARD_OBJECT } from 'twenty-sdk/define';

import {
  APPLICATION_UNIVERSAL_IDENTIFIER,
  OBJ_ACCOUNT,
  OBJ_CAMPAIGN,
  OBJ_CAMPAIGN_RECIPIENT,
  OBJ_CONSENT_EVENT,
  OBJ_MESSAGE,
  OBJ_TEMPLATE,
  OBJ_THREAD,
  OBJ_WEBHOOK_EVENT,
} from './universal-identifiers';

/**
 * Field identifiers are derived, never hand-assigned (specs/00 D-11).
 *
 * `getFieldUniversalIdentifier` is a deterministic UUID v5 over
 * (application, object, field name), so both sides of a relation can compute
 * each other's identifier without importing each other — which is what removes
 * the circular-import problem that two-sided relation files otherwise have.
 *
 * Consequence: **renaming a field changes its identifier and drops the column.**
 * A rename is a migration (add new, backfill in the post-install hook, deprecate
 * old), never an in-place edit.
 */
export const fieldId = (objectUniversalIdentifier: string, name: string): string =>
  getFieldUniversalIdentifier({
    applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
    objectUniversalIdentifier,
    name,
  });

/**
 * Stable identifiers for the entries inside a composite index. They are not
 * fields, but they need durable UUIDs; deriving them from a reserved name
 * keeps them out of the hand-maintained registry.
 */
export const indexFieldId = (
  objectUniversalIdentifier: string,
  indexName: string,
  fieldName: string,
): string => fieldId(objectUniversalIdentifier, `__index__${indexName}__${fieldName}`);

export const PERSON_OBJECT_ID = STANDARD_OBJECT.person.universalIdentifier;

// ─── whatsappAccount ────────────────────────────────────────────────────────
export const ACCOUNT_NAME = fieldId(OBJ_ACCOUNT, 'name');
export const ACCOUNT_PHONE_NUMBER_ID = fieldId(OBJ_ACCOUNT, 'phoneNumberId');
export const ACCOUNT_THREADS = fieldId(OBJ_ACCOUNT, 'threads');
export const ACCOUNT_TEMPLATES = fieldId(OBJ_ACCOUNT, 'templates');
export const ACCOUNT_CAMPAIGNS = fieldId(OBJ_ACCOUNT, 'campaigns');

// ─── whatsappThread ─────────────────────────────────────────────────────────
export const THREAD_PROFILE_NAME = fieldId(OBJ_THREAD, 'profileName');
export const THREAD_WA_ID = fieldId(OBJ_THREAD, 'waId');
export const THREAD_ACCOUNT = fieldId(OBJ_THREAD, 'account');
export const THREAD_PERSON = fieldId(OBJ_THREAD, 'person');
export const THREAD_ASSIGNEE = fieldId(OBJ_THREAD, 'assignee');
export const THREAD_MESSAGES = fieldId(OBJ_THREAD, 'messages');
export const THREAD_CAMPAIGN_RECIPIENTS = fieldId(OBJ_THREAD, 'campaignRecipients');

// ─── whatsappMessage ────────────────────────────────────────────────────────
export const MESSAGE_BODY = fieldId(OBJ_MESSAGE, 'body');
export const MESSAGE_WAMID = fieldId(OBJ_MESSAGE, 'wamid');
export const MESSAGE_WA_TIMESTAMP = fieldId(OBJ_MESSAGE, 'waTimestamp');
export const MESSAGE_MEDIA_FILE = fieldId(OBJ_MESSAGE, 'mediaFile');
export const MESSAGE_THREAD = fieldId(OBJ_MESSAGE, 'thread');
export const MESSAGE_TEMPLATE = fieldId(OBJ_MESSAGE, 'template');
export const MESSAGE_SENT_BY = fieldId(OBJ_MESSAGE, 'sentBy');
export const MESSAGE_CAMPAIGN_RECIPIENT = fieldId(OBJ_MESSAGE, 'campaignRecipient');

// ─── whatsappTemplate ───────────────────────────────────────────────────────
export const TEMPLATE_NAME = fieldId(OBJ_TEMPLATE, 'name');
export const TEMPLATE_META_ID = fieldId(OBJ_TEMPLATE, 'metaTemplateId');
export const TEMPLATE_ACCOUNT = fieldId(OBJ_TEMPLATE, 'account');
export const TEMPLATE_MESSAGES = fieldId(OBJ_TEMPLATE, 'messages');
export const TEMPLATE_CAMPAIGNS = fieldId(OBJ_TEMPLATE, 'campaigns');

// ─── whatsappConsentEvent ───────────────────────────────────────────────────
export const CONSENT_NEW_STATUS = fieldId(OBJ_CONSENT_EVENT, 'newStatus');
export const CONSENT_PERSON = fieldId(OBJ_CONSENT_EVENT, 'person');
export const CONSENT_ACTOR = fieldId(OBJ_CONSENT_EVENT, 'actor');

// ─── whatsappCampaign ───────────────────────────────────────────────────────
export const CAMPAIGN_NAME = fieldId(OBJ_CAMPAIGN, 'name');
export const CAMPAIGN_STATUS = fieldId(OBJ_CAMPAIGN, 'status');
export const CAMPAIGN_ACCOUNT = fieldId(OBJ_CAMPAIGN, 'account');
export const CAMPAIGN_TEMPLATE = fieldId(OBJ_CAMPAIGN, 'template');
export const CAMPAIGN_OWNER = fieldId(OBJ_CAMPAIGN, 'owner');
export const CAMPAIGN_RECIPIENTS = fieldId(OBJ_CAMPAIGN, 'recipients');

// ─── whatsappCampaignRecipient ──────────────────────────────────────────────
export const RECIPIENT_STATUS = fieldId(OBJ_CAMPAIGN_RECIPIENT, 'status');
export const RECIPIENT_CAMPAIGN = fieldId(OBJ_CAMPAIGN_RECIPIENT, 'campaign');
export const RECIPIENT_PERSON = fieldId(OBJ_CAMPAIGN_RECIPIENT, 'person');
export const RECIPIENT_THREAD = fieldId(OBJ_CAMPAIGN_RECIPIENT, 'thread');
export const RECIPIENT_MESSAGE = fieldId(OBJ_CAMPAIGN_RECIPIENT, 'message');

// ─── whatsappWebhookEvent ───────────────────────────────────────────────────
export const WEBHOOK_EVENT_DEDUP_KEY = fieldId(OBJ_WEBHOOK_EVENT, 'dedupKey');

// ─── Person extensions ──────────────────────────────────────────────────────
export const PERSON_WHATSAPP_OPT_IN_STATUS = fieldId(PERSON_OBJECT_ID, 'whatsappOptInStatus');
export const PERSON_WHATSAPP_OPT_IN_UPDATED_AT = fieldId(
  PERSON_OBJECT_ID,
  'whatsappOptInUpdatedAt',
);
export const PERSON_WHATSAPP_THREADS = fieldId(PERSON_OBJECT_ID, 'whatsappThreads');
export const PERSON_WHATSAPP_CONSENT_EVENTS = fieldId(PERSON_OBJECT_ID, 'whatsappConsentEvents');
export const PERSON_WHATSAPP_CAMPAIGN_RECIPIENTS = fieldId(
  PERSON_OBJECT_ID,
  'whatsappCampaignRecipients',
);

// ─── workspaceMember reverse sides ──────────────────────────────────────────
export const WORKSPACE_MEMBER_OBJECT_ID = STANDARD_OBJECT.workspaceMember.universalIdentifier;
export const MEMBER_ASSIGNED_THREADS = fieldId(
  WORKSPACE_MEMBER_OBJECT_ID,
  'assignedWhatsappThreads',
);
export const MEMBER_SENT_MESSAGES = fieldId(WORKSPACE_MEMBER_OBJECT_ID, 'sentWhatsappMessages');
export const MEMBER_CONSENT_ACTIONS = fieldId(WORKSPACE_MEMBER_OBJECT_ID, 'whatsappConsentActions');
export const MEMBER_OWNED_CAMPAIGNS = fieldId(WORKSPACE_MEMBER_OBJECT_ID, 'ownedWhatsappCampaigns');
