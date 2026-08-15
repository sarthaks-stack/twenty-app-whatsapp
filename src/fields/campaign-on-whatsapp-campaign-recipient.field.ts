import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN, OBJ_CAMPAIGN_RECIPIENT } from 'src/constants/universal-identifiers';

/**
 * whatsappCampaignRecipient.campaign → whatsappCampaign (many-to-one).
 *
 * The snapshot belongs to the campaign.
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'campaign'),
  objectUniversalIdentifier: OBJ_CAMPAIGN_RECIPIENT,
  type: FieldType.RELATION,
  name: 'campaign',
  label: 'Campaign',
  icon: 'IconSpeakerphone',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_CAMPAIGN,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_CAMPAIGN, 'recipients'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.CASCADE,
    joinColumnName: 'campaignId',
  },
});
