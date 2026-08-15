import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_MESSAGE, OBJ_TEMPLATE } from 'src/constants/universal-identifiers';

/**
 * whatsappTemplate.messages → whatsappMessage (one-to-many).
 *
 * Reverse side of `whatsappMessage.template`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_TEMPLATE, 'messages'),
  objectUniversalIdentifier: OBJ_TEMPLATE,
  type: FieldType.RELATION,
  name: 'messages',
  label: 'Messages',
  icon: 'IconMessage',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_MESSAGE,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_MESSAGE, 'template'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
