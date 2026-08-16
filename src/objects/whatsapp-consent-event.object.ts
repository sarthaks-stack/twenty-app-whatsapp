import { defineObject, FieldType } from 'twenty-sdk/define';

import { CONSENT_NEW_STATUS, fieldId } from 'src/constants/field-identifiers';
import { OBJ_CONSENT_EVENT } from 'src/constants/universal-identifiers';

const f = (name: string) => fieldId(OBJ_CONSENT_EVENT, name);

/**
 * Append-only consent evidence (FR-CON-1).
 *
 * The denormalised `person.whatsappOptInStatus` makes audiences filterable; this
 * table is what an Angolan Lei 22/11 or GDPR enquiry actually needs — who, when,
 * how, and **what wording was shown**. A SELECT field alone would not survive
 * scrutiny.
 *
 * Never updated or deleted except by the SEC-8 erasure routine, which replaces
 * every event for a person with a single tombstone.
 */
export default defineObject({
  universalIdentifier: OBJ_CONSENT_EVENT,
  nameSingular: 'whatsappConsentEvent',
  namePlural: 'whatsappConsentEvents',
  labelSingular: 'WhatsApp consent event',
  labelPlural: 'WhatsApp consent events',
  description: 'Append-only record of a WhatsApp opt-in or opt-out',
  icon: 'IconWritingSign',
  isUICreatable: false,
  isUIEditable: false,
  // The label identifier must be TEXT-compatible; a SELECT is rejected by the server.
  labelIdentifierFieldMetadataUniversalIdentifier: fieldId(OBJ_CONSENT_EVENT, 'wordingShown'),
  fields: [
    {
      universalIdentifier: CONSENT_NEW_STATUS,
      name: 'newStatus',
      label: 'New status',
      icon: 'IconCheck',
      type: FieldType.SELECT,
      // Nullable for the erasure tombstone, which records a removal rather
      // than a decision and must not claim the person opted anywhere.
      isNullable: true,
      defaultValue: "'OPTED_IN'",
      options: [
        { value: 'OPTED_IN', label: 'Opted in', position: 0, color: 'green' },
        { value: 'OPTED_OUT', label: 'Opted out', position: 1, color: 'red' },
      ],
    },
    {
      universalIdentifier: f('previousStatus'),
      name: 'previousStatus',
      label: 'Previous status',
      icon: 'IconArrowBack',
      type: FieldType.SELECT,
      isNullable: true,
      options: [
        { value: 'OPTED_IN', label: 'Opted in', position: 0, color: 'green' },
        { value: 'OPTED_OUT', label: 'Opted out', position: 1, color: 'red' },
        { value: 'UNKNOWN', label: 'Unknown', position: 2, color: 'gray' },
      ],
    },
    {
      universalIdentifier: f('method'),
      name: 'method',
      label: 'Method',
      icon: 'IconRoute',
      type: FieldType.SELECT,
      defaultValue: "'MANUAL'",
      options: [
        { value: 'KEYWORD', label: 'Keyword', position: 0, color: 'blue' },
        { value: 'MANUAL', label: 'Manual', position: 1, color: 'gray' },
        { value: 'IMPORT', label: 'Import', position: 2, color: 'orange' },
        { value: 'WEB_FORM', label: 'Web form', position: 3, color: 'purple' },
        { value: 'IN_THREAD', label: 'In conversation', position: 4, color: 'green' },
        { value: 'API', label: 'API', position: 5, color: 'sky' },
      ],
    },
    {
      universalIdentifier: f('wordingShown'),
      name: 'wordingShown',
      label: 'Wording shown',
      description: 'The consent language presented to the contact — the evidence that matters',
      icon: 'IconQuote',
      type: FieldType.TEXT,
      isNullable: true,
    },
    {
      universalIdentifier: f('sourceReference'),
      name: 'sourceReference',
      label: 'Source reference',
      description: 'WAMID of the triggering message, import filename, or form URL',
      icon: 'IconLink',
      type: FieldType.TEXT,
      isNullable: true,
    },
    {
      universalIdentifier: f('occurredAt'),
      name: 'occurredAt',
      label: 'Occurred at',
      icon: 'IconClock',
      type: FieldType.DATE_TIME,
      defaultValue: 'now',
    },
    {
      universalIdentifier: f('notes'),
      name: 'notes',
      label: 'Notes',
      icon: 'IconNote',
      type: FieldType.TEXT,
      isNullable: true,
    },
    /**
     * Marks the single row an erasure leaves behind (SEC-8, specs/10 §4.1).
     *
     * A tombstone is not a consent decision and must not be read as one. It
     * records that content was removed, by whom and how much — with no wording,
     * no number and no message — which is the compromise between "erase
     * everything" and "prove the erasure happened". A flag rather than a
     * convention in `notes`, because an auditor filters on it and a substring
     * match on prose is not something to build a compliance answer on.
     */
    {
      universalIdentifier: f('isTombstone'),
      name: 'isTombstone',
      label: 'Erasure tombstone',
      description:
        'This row records a data erasure, not a consent decision: the events it replaced are gone',
      icon: 'IconGrave',
      type: FieldType.BOOLEAN,
      defaultValue: false,
    },
  ],
});
