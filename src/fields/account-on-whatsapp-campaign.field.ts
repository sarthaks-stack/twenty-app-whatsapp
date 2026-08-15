import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_ACCOUNT, OBJ_CAMPAIGN } from 'src/constants/universal-identifiers';

/**
 * whatsappCampaign.account → whatsappAccount (many-to-one).
 *
 * RESTRICT: an account with campaign history cannot be silently removed.
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_CAMPAIGN, 'account'),
  objectUniversalIdentifier: OBJ_CAMPAIGN,
  type: FieldType.RELATION,
  name: 'account',
  label: 'Account',
  icon: 'IconBrandWhatsapp',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_ACCOUNT,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_ACCOUNT, 'campaigns'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.RESTRICT,
    joinColumnName: 'accountId',
  },
});
