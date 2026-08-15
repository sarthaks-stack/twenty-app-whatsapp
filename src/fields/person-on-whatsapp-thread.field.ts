import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId, PERSON_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_THREAD } from 'src/constants/universal-identifiers';

/**
 * whatsappThread.person → person (many-to-one).
 *
 * SET_NULL, not CASCADE: deleting a Person must not silently destroy the conversation. GDPR erasure is an explicit routine (SEC-8), not a foreign key.
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_THREAD, 'person'),
  objectUniversalIdentifier: OBJ_THREAD,
  type: FieldType.RELATION,
  name: 'person',
  label: 'Person',
  icon: 'IconUser',
  relationTargetObjectMetadataUniversalIdentifier: PERSON_OBJECT_ID,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(PERSON_OBJECT_ID, 'whatsappThreads'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.SET_NULL,
    joinColumnName: 'personId',
  },
});
