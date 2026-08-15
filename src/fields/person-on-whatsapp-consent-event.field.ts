import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId, PERSON_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_CONSENT_EVENT } from 'src/constants/universal-identifiers';

/**
 * whatsappConsentEvent.person → person (many-to-one).
 *
 * Consent evidence follows the data subject.
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_CONSENT_EVENT, 'person'),
  objectUniversalIdentifier: OBJ_CONSENT_EVENT,
  type: FieldType.RELATION,
  name: 'person',
  label: 'Person',
  icon: 'IconUser',
  relationTargetObjectMetadataUniversalIdentifier: PERSON_OBJECT_ID,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(PERSON_OBJECT_ID, 'whatsappConsentEvents'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.CASCADE,
    joinColumnName: 'personId',
  },
});
