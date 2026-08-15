import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { fieldId, WORKSPACE_MEMBER_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_CAMPAIGN } from 'src/constants/universal-identifiers';

/**
 * whatsappCampaign.owner → workspaceMember (many-to-one).
 *
 * Named `owner`, not `createdBy`: every object already has a platform `createdBy` ACTOR field and the names would collide on sync. SEC-12 is satisfied by both.
 *
 * Both sides of a relation live in their own file and derive each other's
 * identifier through `fieldId`, which is why neither has to import the other
 * (specs/00 D-11).
 */
export default defineField({
  universalIdentifier: fieldId(OBJ_CAMPAIGN, 'owner'),
  objectUniversalIdentifier: OBJ_CAMPAIGN,
  type: FieldType.RELATION,
  name: 'owner',
  label: 'Owner',
  icon: 'IconUser',
  relationTargetObjectMetadataUniversalIdentifier: WORKSPACE_MEMBER_OBJECT_ID,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(WORKSPACE_MEMBER_OBJECT_ID, 'ownedWhatsappCampaigns'),
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.SET_NULL,
    joinColumnName: 'ownerId',
  },
});
