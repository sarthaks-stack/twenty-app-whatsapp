import { defineObject, FieldType } from 'twenty-sdk/define';

import { fieldId, WEBHOOK_EVENT_DEDUP_KEY } from 'src/constants/field-identifiers';
import { OBJ_WEBHOOK_EVENT } from 'src/constants/universal-identifiers';

const f = (name: string) => fieldId(OBJ_WEBHOOK_EVENT, name);

/**
 * The raw webhook log: replay surface, debug record, and the only source for
 * reprocessing history (AR-7, TRD §12.4).
 *
 * Meta retries an unacknowledged delivery for 7 days and offers no replay API
 * afterwards, so retention below 7 days is rejected by validation — this table
 * is the sole record once that window closes.
 *
 * Highest-growth table in the app (~3 rows per message), which is why the
 * 30-day purge is non-optional at the NFR-S1 design point.
 */
export default defineObject({
  universalIdentifier: OBJ_WEBHOOK_EVENT,
  nameSingular: 'whatsappWebhookEvent',
  namePlural: 'whatsappWebhookEvents',
  labelSingular: 'WhatsApp webhook event',
  labelPlural: 'WhatsApp webhook events',
  description: 'Raw Meta webhook payload, retained for replay and debugging',
  icon: 'IconWebhook',
  isUICreatable: false,
  isUIEditable: false,
  labelIdentifierFieldMetadataUniversalIdentifier: WEBHOOK_EVENT_DEDUP_KEY,
  fields: [
    {
      universalIdentifier: WEBHOOK_EVENT_DEDUP_KEY,
      name: 'dedupKey',
      label: 'Dedup key',
      description:
        'msg:{wamid} · st:{wamid}:{status} · tpl:… · acct:… — status keys include the status so a legitimate sent→delivered→read sequence is three rows while a duplicate is one (AR-8)',
      icon: 'IconFingerprint',
      type: FieldType.TEXT,
      isNullable: true,
      defaultValue: null,
      isUnique: true,
    },
    {
      universalIdentifier: f('webhookField'),
      name: 'webhookField',
      label: 'Webhook field',
      description:
        'messages, message_template_status_update, … Named `webhookField` because `field` is reserved by the server, which would otherwise silently append a "Custom" suffix.',
      icon: 'IconTag',
      type: FieldType.TEXT,
      defaultValue: "''",
    },
    {
      universalIdentifier: f('payload'),
      name: 'payload',
      label: 'Payload',
      description: 'The single changes[] element, plus _entryId and _receivedAt',
      icon: 'IconBraces',
      type: FieldType.RAW_JSON,
      isNullable: true,
    },
    {
      universalIdentifier: f('processingStatus'),
      name: 'processingStatus',
      label: 'Processing status',
      icon: 'IconProgress',
      type: FieldType.SELECT,
      defaultValue: "'RECEIVED'",
      options: [
        { value: 'RECEIVED', label: 'Received', position: 0, color: 'gray' },
        { value: 'PROCESSED', label: 'Processed', position: 1, color: 'green' },
        { value: 'FAILED', label: 'Failed', position: 2, color: 'red' },
        { value: 'SKIPPED_DUPLICATE', label: 'Duplicate', position: 3, color: 'gray' },
        { value: 'UNCLAIMED', label: 'Unclaimed number', position: 4, color: 'orange' },
      ],
    },
    {
      universalIdentifier: f('error'),
      name: 'error',
      label: 'Error',
      description: 'Processor failure detail, for replay',
      icon: 'IconAlertTriangle',
      type: FieldType.TEXT,
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
    {
      universalIdentifier: f('receivedAt'),
      name: 'receivedAt',
      label: 'Received at',
      icon: 'IconClock',
      type: FieldType.DATE_TIME,
      defaultValue: 'now',
    },
    {
      universalIdentifier: f('processedAt'),
      name: 'processedAt',
      label: 'Processed at',
      icon: 'IconCheck',
      type: FieldType.DATE_TIME,
      isNullable: true,
    },
  ],
});
