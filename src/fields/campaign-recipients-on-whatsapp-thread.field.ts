import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN_RECIPIENT, OBJ_THREAD } from 'src/constants/universal-identifiers';

/**
 * whatsappThread.campaignRecipients → whatsappCampaignRecipient (one-to-many).
 *
 * Reverse side of `whatsappCampaignRecipient.thread`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_THREAD, 'campaignRecipients'),
  objectUniversalIdentifier: OBJ_THREAD,
  type: FieldType.RELATION,
  name: 'campaignRecipients',
  label: 'Campaign Recipients',
  icon: 'IconUserCheck',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_CAMPAIGN_RECIPIENT,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'thread'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
