import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId } from 'src/constants/field-identifiers';
import { OBJ_MESSAGE, OBJ_TEMPLATE } from 'src/constants/universal-identifiers';

/**
 * whatsappMessage.template → whatsappTemplate (many-to-one).
 *
 * SET_NULL keeps sent history when a template is removed; templateName/language/category are denormalised on the message for exactly this reason (FR-TPL-5).
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_MESSAGE, 'template'),
  objectUniversalIdentifier: OBJ_MESSAGE,
  type: FieldType.RELATION,
  name: 'template',
  label: 'Template',
  icon: 'IconTemplate',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_TEMPLATE,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_TEMPLATE, 'messages'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.SET_NULL,
    joinColumnName: 'templateId',
  },
});
