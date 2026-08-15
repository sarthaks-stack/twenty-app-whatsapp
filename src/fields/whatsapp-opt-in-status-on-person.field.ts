import { defineField, FieldType } from 'twenty-sdk/define';

import { PERSON_OBJECT_ID, PERSON_WHATSAPP_OPT_IN_STATUS } from 'src/constants/field-identifiers';

/**
 * The denormalised current consent state (FR-CON-1).
 *
 * Exists so audiences, views and filters are indexable; the append-only
 * `whatsappConsentEvent` records are the evidence. Both are written by one
 * function so they cannot diverge, and a direct edit of this field is
 * back-filled with a consent event by a database-event trigger — so a manual
 * change is permitted *and* audited (specs/06 §11).
 *
 * A person created from an inbound message is `unknown`, never `opted_in`:
 * messaging support is not marketing consent, and treating it as such is the
 * fastest route to a red quality rating (R-11).
 */
export default defineField({
  universalIdentifier: PERSON_WHATSAPP_OPT_IN_STATUS,
  objectUniversalIdentifier: PERSON_OBJECT_ID,
  type: FieldType.SELECT,
  name: 'whatsappOptInStatus',
  label: 'WhatsApp opt-in',
  description: 'Consent state for business-initiated WhatsApp messages',
  icon: 'IconBrandWhatsapp',
  defaultValue: "'UNKNOWN'",
  options: [
    { value: 'OPTED_IN', label: 'Opted in', position: 0, color: 'green' },
    { value: 'OPTED_OUT', label: 'Opted out', position: 1, color: 'red' },
    { value: 'UNKNOWN', label: 'Unknown', position: 2, color: 'gray' },
  ],
});
