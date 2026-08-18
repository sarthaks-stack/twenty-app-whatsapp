import { defineNavigationMenuItem, NavigationMenuItemType } from 'twenty-sdk/define';

import {
  NAV_CAMPAIGNS,
  NAV_WHATSAPP_FOLDER,
  PL_CAMPAIGNS,
} from '../constants/universal-identifiers';

/** Below the inbox, inside the same WhatsApp folder. */
export default defineNavigationMenuItem({
  universalIdentifier: NAV_CAMPAIGNS,
  type: NavigationMenuItemType.PAGE_LAYOUT,
  name: 'Campaigns',
  icon: 'IconSend',
  position: 1,
  folderUniversalIdentifier: NAV_WHATSAPP_FOLDER,
  pageLayoutUniversalIdentifier: PL_CAMPAIGNS,
});
