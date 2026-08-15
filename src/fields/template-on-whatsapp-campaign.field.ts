import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN, OBJ_TEMPLATE } from 'src/constants/universal-identifiers';

/**
 * whatsappCampaign.template → whatsappTemplate (many-to-one).
 *
 * RESTRICT: removing a template mid-campaign would strand every pending recipient.
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_CAMPAIGN, 'template'),
  objectUniversalIdentifier: OBJ_CAMPAIGN,
  type: FieldType.RELATION,
  name: 'template',
  label: 'Template',
  icon: 'IconTemplate',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_TEMPLATE,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_TEMPLATE, 'campaigns'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.RESTRICT,
    joinColumnName: 'templateId',
  },
});
