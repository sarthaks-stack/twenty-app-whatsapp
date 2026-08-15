import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId, WORKSPACE_MEMBER_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_THREAD } from 'src/constants/universal-identifiers';

/**
 * workspaceMember.assignedWhatsappThreads → whatsappThread (one-to-many).
 *
 * Reverse side of `whatsappThread.assignee`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(WORKSPACE_MEMBER_OBJECT_ID, 'assignedWhatsappThreads'),
  objectUniversalIdentifier: WORKSPACE_MEMBER_OBJECT_ID,
  type: FieldType.RELATION,
  name: 'assignedWhatsappThreads',
  label: 'Assigned Whatsapp Threads',
  icon: 'IconMessageCircle',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_THREAD,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_THREAD, 'assignee'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
