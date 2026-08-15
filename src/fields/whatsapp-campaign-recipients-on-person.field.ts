import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId, PERSON_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN_RECIPIENT } from 'src/constants/universal-identifiers';

/**
 * person.whatsappCampaignRecipients → whatsappCampaignRecipient (one-to-many).
 *
 * Reverse side of `whatsappCampaignRecipient.person`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(PERSON_OBJECT_ID, 'whatsappCampaignRecipients'),
  objectUniversalIdentifier: PERSON_OBJECT_ID,
  type: FieldType.RELATION,
  name: 'whatsappCampaignRecipients',
  label: 'Whatsapp Campaign Recipients',
  icon: 'IconUserCheck',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_CAMPAIGN_RECIPIENT,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'person'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
