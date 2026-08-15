import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN, OBJ_CAMPAIGN_RECIPIENT } from 'src/constants/universal-identifiers';

/**
 * whatsappCampaign.recipients → whatsappCampaignRecipient (one-to-many).
 *
 * Reverse side of `whatsappCampaignRecipient.campaign`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_CAMPAIGN, 'recipients'),
  objectUniversalIdentifier: OBJ_CAMPAIGN,
  type: FieldType.RELATION,
  name: 'recipients',
  label: 'Recipients',
  icon: 'IconUserCheck',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_CAMPAIGN_RECIPIENT,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'campaign'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
