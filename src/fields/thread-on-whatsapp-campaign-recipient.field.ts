import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN_RECIPIENT, OBJ_THREAD } from 'src/constants/universal-identifiers';

/**
 * whatsappCampaignRecipient.thread → whatsappThread (many-to-one).
 *
 * Set when the send creates or joins a conversation.
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'thread'),
  objectUniversalIdentifier: OBJ_CAMPAIGN_RECIPIENT,
  type: FieldType.RELATION,
  name: 'thread',
  label: 'Thread',
  icon: 'IconMessageCircle',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_THREAD,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_THREAD, 'campaignRecipients'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.SET_NULL,
    joinColumnName: 'threadId',
  },
});
