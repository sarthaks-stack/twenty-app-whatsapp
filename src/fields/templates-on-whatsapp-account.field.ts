import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_ACCOUNT, OBJ_TEMPLATE } from 'src/constants/universal-identifiers';

/**
 * whatsappAccount.templates → whatsappTemplate (one-to-many).
 *
 * Reverse side of `whatsappTemplate.account`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_ACCOUNT, 'templates'),
  objectUniversalIdentifier: OBJ_ACCOUNT,
  type: FieldType.RELATION,
  name: 'templates',
  label: 'Templates',
  icon: 'IconTemplate',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_TEMPLATE,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_TEMPLATE, 'account'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
