import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { fieldId, WORKSPACE_MEMBER_OBJECT_ID } from 'src/constants/field-identifiers';
import { OBJ_CONSENT_EVENT } from 'src/constants/universal-identifiers';

/**
 * workspaceMember.whatsappConsentActions → whatsappConsentEvent (one-to-many).
 *
 * Reverse side of `whatsappConsentEvent.actor`; `onDelete` is declared on the
 * many-to-one side only.
 */
export default defineField({
  universalIdentifier: fieldId(WORKSPACE_MEMBER_OBJECT_ID, 'whatsappConsentActions'),
  objectUniversalIdentifier: WORKSPACE_MEMBER_OBJECT_ID,
  type: FieldType.RELATION,
  name: 'whatsappConsentActions',
  label: 'Whatsapp Consent Actions',
  icon: 'IconWritingSign',
  relationTargetObjectMetadataUniversalIdentifier: OBJ_CONSENT_EVENT,
  relationTargetFieldMetadataUniversalIdentifier: fieldId(OBJ_CONSENT_EVENT, 'actor'),
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
