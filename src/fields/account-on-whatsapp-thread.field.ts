import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_ACCOUNT, OBJ_THREAD } from 'src/constants/universal-identifiers';

/**
 * whatsappThread.account → whatsappAccount (many-to-one).
 *
 * Deleting the account removes its conversations; they have no meaning without a number.
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_THREAD, 'account'),
  objectUniversalIdentifier: OBJ_THREAD,
  type: FieldType.RELATION,
  name: 'account',
  label: 'Account',
  icon: 'IconBrandWhatsapp',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_ACCOUNT,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_ACCOUNT, 'threads'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.CASCADE,
    joinColumnName: 'accountId',
  },
});
