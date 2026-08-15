import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId, PERSON_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN_RECIPIENT } from 'src/constants/universal-identifiers';

/**
 * whatsappCampaignRecipient.person → person (many-to-one).
 *
 * Answers "which campaigns did this person receive".
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'person'),
  objectUniversalIdentifier: OBJ_CAMPAIGN_RECIPIENT,
  type: FieldType.RELATION,
  name: 'person',
  label: 'Person',
  icon: 'IconUser',
  relationTargetObjectMetadataUniversalIdentifier: PERSON_OBJECT_ID,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(PERSON_OBJECT_ID, 'whatsappCampaignRecipients'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.CASCADE,
    joinColumnName: 'personId',
  },
});
