import { defineNavigationMenuItem, NavigationMenuItemType } from 'twenty-sdk/define';

import { NAV_WHATSAPP_FOLDER } from '../constants/universal-identifiers';

/**
 * One "WhatsApp" section in the left sidebar, holding Inbox and Campaigns.
 *
 * Two top-level entries were fine for two surfaces; the review pointed out
 * they do not scale — every future surface (reports, broadcasts) would claim
 * another top-level row. A folder gives the integration one entry that grows
 * inward instead of downward.
 */
export default defineNavigationMenuItem({
  universalIdentifier: NAV_WHATSAPP_FOLDER,
  type: NavigationMenuItemType.FOLDER,
  name: 'WhatsApp',
  icon: 'IconBrandWhatsapp',
  position: 500,
});
