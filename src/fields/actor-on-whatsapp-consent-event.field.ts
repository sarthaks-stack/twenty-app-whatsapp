import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId, WORKSPACE_MEMBER_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_CONSENT_EVENT } from 'src/constants/universal-identifiers';

/**
 * whatsappConsentEvent.actor → workspaceMember (many-to-one).
 *
 * Null for automatic keyword handling (FR-CON-3).
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_CONSENT_EVENT, 'actor'),
  objectUniversalIdentifier: OBJ_CONSENT_EVENT,
  type: FieldType.RELATION,
  name: 'actor',
  label: 'Actor',
  icon: 'IconUserCog',
  relationTargetObjectMetadataUniversalIdentifier: WORKSPACE_MEMBER_OBJECT_ID,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(WORKSPACE_MEMBER_OBJECT_ID, 'whatsappConsentActions'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.SET_NULL,
    joinColumnName: 'actorId',
  },
});
