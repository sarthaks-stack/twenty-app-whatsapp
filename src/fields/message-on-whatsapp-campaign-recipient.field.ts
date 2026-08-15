import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN_RECIPIENT, OBJ_MESSAGE } from 'src/constants/universal-identifiers';

/**
 * whatsappCampaignRecipient.message → whatsappMessage (many-to-one).
 *
 * Set once sent; carries the WAMID and its status.
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'message'),
  objectUniversalIdentifier: OBJ_CAMPAIGN_RECIPIENT,
  type: FieldType.RELATION,
  name: 'message',
  label: 'Message',
  icon: 'IconMessage',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_MESSAGE,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_MESSAGE, 'campaignRecipient'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.SET_NULL,
    joinColumnName: 'messageId',
  },
});
