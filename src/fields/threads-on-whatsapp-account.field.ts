import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_ACCOUNT, OBJ_THREAD } from 'src/constants/universal-identifiers';

/**
 * whatsappAccount.threads → whatsappThread (one-to-many).
 *
 * Reverse side of `whatsappThread.account`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_ACCOUNT, 'threads'),
  objectUniversalIdentifier: OBJ_ACCOUNT,
  type: FieldType.RELATION,
  name: 'threads',
  label: 'Threads',
  icon: 'IconMessageCircle',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_THREAD,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_THREAD, 'account'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
