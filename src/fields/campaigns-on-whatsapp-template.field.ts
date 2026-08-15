import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN, OBJ_TEMPLATE } from 'src/constants/universal-identifiers';

/**
 * whatsappTemplate.campaigns → whatsappCampaign (one-to-many).
 *
 * Reverse side of `whatsappCampaign.template`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_TEMPLATE, 'campaigns'),
  objectUniversalIdentifier: OBJ_TEMPLATE,
  type: FieldType.RELATION,
  name: 'campaigns',
  label: 'Campaigns',
  icon: 'IconSpeakerphone',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_CAMPAIGN,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_CAMPAIGN, 'template'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
