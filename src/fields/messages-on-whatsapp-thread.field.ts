import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_MESSAGE, OBJ_THREAD } from 'src/constants/universal-identifiers';

/**
 * whatsappThread.messages → whatsappMessage (one-to-many).
 *
 * Reverse side of `whatsappMessage.thread`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_THREAD, 'messages'),
  objectUniversalIdentifier: OBJ_THREAD,
  type: FieldType.RELATION,
  name: 'messages',
  label: 'Messages',
  icon: 'IconMessage',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_MESSAGE,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_MESSAGE, 'thread'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
