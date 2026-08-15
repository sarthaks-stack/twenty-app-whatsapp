import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId, PERSON_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_CONSENT_EVENT } from 'src/constants/universal-identifiers';

/**
 * person.whatsappConsentEvents → whatsappConsentEvent (one-to-many).
 *
 * Reverse side of `whatsappConsentEvent.person`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(PERSON_OBJECT_ID, 'whatsappConsentEvents'),
  objectUniversalIdentifier: PERSON_OBJECT_ID,
  type: FieldType.RELATION,
  name: 'whatsappConsentEvents',
  label: 'Whatsapp Consent Events',
  icon: 'IconWritingSign',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_CONSENT_EVENT,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_CONSENT_EVENT, 'person'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
