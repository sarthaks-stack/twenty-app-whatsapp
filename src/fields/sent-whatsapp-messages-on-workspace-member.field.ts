import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId, WORKSPACE_MEMBER_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_MESSAGE } from 'src/constants/universal-identifiers';

/**
 * workspaceMember.sentWhatsappMessages → whatsappMessage (one-to-many).
 *
 * Reverse side of `whatsappMessage.sentBy`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(WORKSPACE_MEMBER_OBJECT_ID, 'sentWhatsappMessages'),
  objectUniversalIdentifier: WORKSPACE_MEMBER_OBJECT_ID,
  type: FieldType.RELATION,
  name: 'sentWhatsappMessages',
  label: 'Sent Whatsapp Messages',
  icon: 'IconSend',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_MESSAGE,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_MESSAGE, 'sentBy'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
