import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId, WORKSPACE_MEMBER_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_MESSAGE } from 'src/constants/universal-identifiers';

/**
 * whatsappMessage.sentBy → workspaceMember (many-to-one).
 *
 * Outbound audit (FR-OUT-6).
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_MESSAGE, 'sentBy'),
  objectUniversalIdentifier: OBJ_MESSAGE,
  type: FieldType.RELATION,
  name: 'sentBy',
  label: 'Sent By',
  icon: 'IconUser',
  relationTargetObjectMetadataUniversalIdentifier: WORKSPACE_MEMBER_OBJECT_ID,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(WORKSPACE_MEMBER_OBJECT_ID, 'sentWhatsappMessages'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.SET_NULL,
    joinColumnName: 'sentById',
  },
});
