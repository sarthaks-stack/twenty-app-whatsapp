import { defineObject, FieldType } from 'twenty-sdk/define';

import { fieldId, RECIPIENT_STATUS } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN_RECIPIENT } from 'src/constants/universal-identifiers';

const f = (name: string) => fieldId(OBJ_CAMPAIGN_RECIPIENT, name);

/**
 * The audience snapshot row, and the unit of idempotency (AR-20, FR-CAM-9).
 *
 * Excluded recipients are kept as rows rather than dropped: that is what makes
 * the exclusion breakdown auditable ("show me the 412 we skipped and why") and
 * what lets a later consent campaign pick them up.
 *
 * `resolvedParameters` and `resolvedPhone` are written at snapshot time, so a
 * send or a retry reuses identical content and editing a Person mid-campaign
 * cannot change what a half-sent campaign says.
 */
export default defineObject({
  universalIdentifier: OBJ_CAMPAIGN_RECIPIENT,
  nameSingular: 'whatsappCampaignRecipient',
  namePlural: 'whatsappCampaignRecipients',
  labelSingular: 'Campaign recipient',
  labelPlural: 'Campaign recipients',
  description: 'One person in a campaign audience snapshot',
  icon: 'IconUserCheck',
  isUICreatable: false,
  isUIEditable: false,
  // The label identifier must be TEXT-compatible; a SELECT is rejected by the server.
  labelIdentifierFieldMetadataUniversalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'resolvedPhone'),
  fields: [
    {
      universalIdentifier: RECIPIENT_STATUS,
      name: 'status',
      label: 'Status',
      icon: 'IconProgress',
      type: FieldType.SELECT,
      defaultValue: "'PENDING'",
      options: [
        { value: 'PENDING', label: 'Pending', position: 0, color: 'gray' },
        { value: 'EXCLUDED', label: 'Excluded', position: 1, color: 'gray' },
        { value: 'CLAIMED', label: 'Claimed', position: 2, color: 'sky' },
        { value: 'QUEUED', label: 'Queued', position: 3, color: 'blue' },
        { value: 'SENT', label: 'Sent', position: 4, color: 'sky' },
        { value: 'DELIVERED', label: 'Delivered', position: 5, color: 'turquoise' },
        { value: 'READ', label: 'Read', position: 6, color: 'green' },
        { value: 'FAILED', label: 'Failed', position: 7, color: 'red' },
        { value: 'SKIPPED', label: 'Skipped', position: 8, color: 'orange' },
        { value: 'RESPONDED', label: 'Responded', position: 9, color: 'jade' },
      ],
    },
    {
      universalIdentifier: f('exclusionReason'),
      name: 'exclusionReason',
      label: 'Exclusion reason',
      icon: 'IconFilterOff',
      type: FieldType.SELECT,
      isNullable: true,
      options: [
        { value: 'OPTED_OUT', label: 'Opted out', position: 0, color: 'red' },
        { value: 'NO_CONSENT', label: 'No opt-in', position: 1, color: 'orange' },
        { value: 'INVALID_PHONE', label: 'Invalid phone', position: 2, color: 'gray' },
        { value: 'DUPLICATE', label: 'Duplicate number', position: 3, color: 'gray' },
        { value: 'MISSING_VARIABLES', label: 'Missing variables', position: 4, color: 'amber' },
        { value: 'BLOCKED', label: 'Blocked', position: 5, color: 'red' },
      ],
    },
    {
      universalIdentifier: f('resolvedParameters'),
      name: 'resolvedParameters',
      label: 'Resolved parameters',
      description: 'Rendered at snapshot time, before any send, so retries reuse identical content',
      icon: 'IconVariable',
      type: FieldType.RAW_JSON,
      isNullable: true,
    },
    {
      universalIdentifier: f('resolvedPhone'),
      name: 'resolvedPhone',
      label: 'Resolved phone',
      description: 'E.164 captured at snapshot time — the audience is immutable',
      icon: 'IconPhone',
      type: FieldType.TEXT,
      isNullable: true,
    },
    {
      universalIdentifier: f('errorCode'),
      name: 'errorCode',
      label: 'Error code',
      icon: 'IconAlertCircle',
      type: FieldType.TEXT,
      isNullable: true,
    },
    {
      universalIdentifier: f('errorDetail'),
      name: 'errorDetail',
      label: 'Error detail',
      icon: 'IconAlertCircle',
      type: FieldType.TEXT,
      isNullable: true,
    },
    {
      universalIdentifier: f('claimedAt'),
      name: 'claimedAt',
      label: 'Claimed at',
      description: 'Batch-claim lease; stale claims are reverted to pending after 10 minutes',
      icon: 'IconLock',
      type: FieldType.DATE_TIME,
      isNullable: true,
    },
    {
      universalIdentifier: f('sentAt'),
      name: 'sentAt',
      label: 'Sent at',
      icon: 'IconSend',
      type: FieldType.DATE_TIME,
      isNullable: true,
    },
    {
      universalIdentifier: f('deliveredAt'),
      name: 'deliveredAt',
      label: 'Delivered at',
      icon: 'IconChecks',
      type: FieldType.DATE_TIME,
      isNullable: true,
    },
    {
      universalIdentifier: f('readAt'),
      name: 'readAt',
      label: 'Read at',
      icon: 'IconEyeCheck',
      type: FieldType.DATE_TIME,
      isNullable: true,
    },
    {
      universalIdentifier: f('respondedAt'),
      name: 'respondedAt',
      label: 'Responded at',
      icon: 'IconMessageReply',
      type: FieldType.DATE_TIME,
      isNullable: true,
    },
    {
      universalIdentifier: f('attemptCount'),
      name: 'attemptCount',
      label: 'Attempts',
      icon: 'IconRefresh',
      type: FieldType.NUMBER,
      defaultValue: 0,
    },
  ],
});
