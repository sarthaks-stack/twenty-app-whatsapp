import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_ACCOUNT, OBJ_CAMPAIGN } from 'src/constants/universal-identifiers';

/**
 * whatsappAccount.campaigns → whatsappCampaign (one-to-many).
 *
 * Reverse side of `whatsappCampaign.account`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_ACCOUNT, 'campaigns'),
  objectUniversalIdentifier: OBJ_ACCOUNT,
  type: FieldType.RELATION,
  name: 'campaigns',
  label: 'Campaigns',
  icon: 'IconSpeakerphone',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_CAMPAIGN,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_CAMPAIGN, 'account'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
