import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN_RECIPIENT, OBJ_MESSAGE } from 'src/constants/universal-identifiers';

/**
 * whatsappMessage.campaignRecipient → whatsappCampaignRecipient (one-to-many).
 *
 * Reverse side of `whatsappCampaignRecipient.message`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_MESSAGE, 'campaignRecipient'),
  objectUniversalIdentifier: OBJ_MESSAGE,
  type: FieldType.RELATION,
  name: 'campaignRecipient',
  label: 'Campaign Recipient',
  icon: 'IconUserCheck',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_CAMPAIGN_RECIPIENT,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'message'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
