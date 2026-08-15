import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId, WORKSPACE_MEMBER_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN } from 'src/constants/universal-identifiers';

/**
 * workspaceMember.ownedWhatsappCampaigns → whatsappCampaign (one-to-many).
 *
 * Reverse side of `whatsappCampaign.owner`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(WORKSPACE_MEMBER_OBJECT_ID, 'ownedWhatsappCampaigns'),
  objectUniversalIdentifier: WORKSPACE_MEMBER_OBJECT_ID,
  type: FieldType.RELATION,
  name: 'ownedWhatsappCampaigns',
  label: 'Owned Whatsapp Campaigns',
  icon: 'IconSpeakerphone',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_CAMPAIGN,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_CAMPAIGN, 'owner'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
