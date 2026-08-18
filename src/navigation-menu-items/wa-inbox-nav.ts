import { defineNavigationMenuItem, NavigationMenuItemType } from 'twenty-sdk/define';

import {
  NAV_INBOX,
  NAV_WHATSAPP_FOLDER,
  PL_INBOX,
} from '../constants/universal-identifiers';

/**
 * The Inbox, inside the WhatsApp sidebar folder.
 *
 * CLAUDE.md names the opposite mistake outright: a page layout with no
 * navigation item is a page nobody can reach. This is the item that makes the
 * inbox exist for a user rather than only for a URL. The folder carries the
 * "WhatsApp" name, so this entry is just "Inbox".
 */
export default defineNavigationMenuItem({
  universalIdentifier: NAV_INBOX,
  type: NavigationMenuItemType.PAGE_LAYOUT,
  name: 'Inbox',
  icon: 'IconInbox',
  position: 0,
  folderUniversalIdentifier: NAV_WHATSAPP_FOLDER,
  pageLayoutUniversalIdentifier: PL_INBOX,
});
