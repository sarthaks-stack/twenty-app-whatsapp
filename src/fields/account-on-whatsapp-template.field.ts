import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_ACCOUNT, OBJ_TEMPLATE } from 'src/constants/universal-identifiers';

/**
 * whatsappTemplate.account → whatsappAccount (many-to-one).
 *
 * Templates are WABA-scoped.
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_TEMPLATE, 'account'),
  objectUniversalIdentifier: OBJ_TEMPLATE,
  type: FieldType.RELATION,
  name: 'account',
  label: 'Account',
  icon: 'IconBrandWhatsapp',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_ACCOUNT,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_ACCOUNT, 'templates'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.CASCADE,
    joinColumnName: 'accountId',
  },
});
