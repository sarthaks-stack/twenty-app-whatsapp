import { defineNavigationMenuItem, NavigationMenuItemType } from 'twenty-sdk/define';

import { NAV_CAMPAIGNS, PL_CAMPAIGNS } from '../constants/universal-identifiers';

/** Beside the inbox, one position later. */
export default defineNavigationMenuItem({
  universalIdentifier: NAV_CAMPAIGNS,
  type: NavigationMenuItemType.PAGE_LAYOUT,
  name: 'WhatsApp Campaigns',
  icon: 'IconSend',
  position: 501,
  pageLayoutUniversalIdentifier: PL_CAMPAIGNS,
});
