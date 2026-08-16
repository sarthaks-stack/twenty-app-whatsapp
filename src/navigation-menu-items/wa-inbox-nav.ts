import { defineNavigationMenuItem, NavigationMenuItemType } from 'twenty-sdk/define';

import { NAV_INBOX, PL_INBOX } from '../constants/universal-identifiers';

/**
 * The Inbox in the left sidebar.
 *
 * CLAUDE.md names the opposite mistake outright: a page layout with no
 * navigation item is a page nobody can reach. This is the item that makes the
 * inbox exist for a user rather than only for a URL.
 */
export default defineNavigationMenuItem({
  universalIdentifier: NAV_INBOX,
  type: NavigationMenuItemType.PAGE_LAYOUT,
  name: 'WhatsApp',
  icon: 'IconBrandWhatsapp',
  position: 500,
  pageLayoutUniversalIdentifier: PL_INBOX,
});
