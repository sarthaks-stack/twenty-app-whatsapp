import { defineCommandMenuItem, STANDARD_OBJECT } from 'twenty-sdk/define';

import { CMI_OPEN_CHAT, FC_SIDE_PANEL_CHAT } from '../constants/universal-identifiers';

/**
 * "Open WhatsApp chat", from any Person, anywhere (FR-UI-3).
 *
 * The condition is not decoration. `<ThreadView>` takes the first selected id,
 * which is only a meaningful thing to do when there is exactly one — without
 * the guard, a rep who had select-all'd a list and reached for the command menu
 * would be shown one arbitrary contact's private conversation.
 */
export default defineCommandMenuItem({
  universalIdentifier: CMI_OPEN_CHAT,
  label: 'Abrir conversa de WhatsApp',
  shortLabel: 'WhatsApp',
  availabilityType: 'RECORD_SELECTION',
  availabilityObjectUniversalIdentifier: STANDARD_OBJECT.person.universalIdentifier,
  frontComponentUniversalIdentifier: FC_SIDE_PANEL_CHAT,
  conditionalAvailabilityExpression: 'numberOfSelectedRecords === 1',
});
