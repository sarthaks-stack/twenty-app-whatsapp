import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_MESSAGE, OBJ_THREAD } from 'src/constants/universal-identifiers';

/**
 * whatsappMessage.thread → whatsappThread (many-to-one).
 *
 * Messages exist only within a conversation.
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_MESSAGE, 'thread'),
  objectUniversalIdentifier: OBJ_MESSAGE,
  type: FieldType.RELATION,
  name: 'thread',
  label: 'Thread',
  icon: 'IconMessageCircle',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_THREAD,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_THREAD, 'messages'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.CASCADE,
    joinColumnName: 'threadId',
  },
});
