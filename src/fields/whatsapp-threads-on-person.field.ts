import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId, PERSON_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_THREAD } from 'src/constants/universal-identifiers';

/**
 * person.whatsappThreads → whatsappThread (one-to-many).
 *
 * Reverse side of `whatsappThread.person`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(PERSON_OBJECT_ID, 'whatsappThreads'),
  objectUniversalIdentifier: PERSON_OBJECT_ID,
  type: FieldType.RELATION,
  name: 'whatsappThreads',
  label: 'Whatsapp Threads',
  icon: 'IconBrandWhatsapp',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_THREAD,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_THREAD, 'person'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
