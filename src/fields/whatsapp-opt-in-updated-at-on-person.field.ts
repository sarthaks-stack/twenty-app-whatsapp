import { defineField, FieldType } from 'twenty-sdk/define';

import {
  PERSON_OBJECT_ID,
  PERSON_WHATSAPP_OPT_IN_UPDATED_AT,
} from 'src/constants/field-identifiers';

/**
 * When the consent state last changed, denormalised from the latest
 * `whatsappConsentEvent` so views can filter and sort on recency without
 * joining the evidence table.
 */
export default defineField({
  universalIdentifier: PERSON_WHATSAPP_OPT_IN_UPDATED_AT,
  objectUniversalIdentifier: PERSON_OBJECT_ID,
  type: FieldType.DATE_TIME,
  name: 'whatsappOptInUpdatedAt',
  label: 'WhatsApp opt-in updated',
  icon: 'IconClockEdit',
  isNullable: true,
});
