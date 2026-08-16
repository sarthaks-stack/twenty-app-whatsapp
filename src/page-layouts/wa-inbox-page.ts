import { definePageLayout, PageLayoutTabLayoutMode, PageLayoutType } from 'twenty-sdk/define';

import {
  FC_INBOX,
  FC_INBOX_TOASTER,
  PL_INBOX,
  PL_INBOX_TAB,
  PL_INBOX_TOASTER_WIDGET,
  PL_INBOX_WIDGET,
} from '../constants/universal-identifiers';

/**
 * The page the Inbox navigation item opens (FR-UI-2).
 *
 * One visible widget: the inbox owns its whole surface, including its own
 * two-pane split. A page layout with several visible widgets would divide a
 * width the component already divides, and neither would know about the other.
 *
 * The second widget is the toaster, and it is `isHeadless` — it renders nothing
 * and takes no space. This is where D-10 layer 2 says to mount it, because it
 * is the page a rep leaves open.
 */
export default definePageLayout({
  universalIdentifier: PL_INBOX,
  name: 'WhatsApp Inbox',
  type: PageLayoutType.STANDALONE_PAGE,
  tabs: [
    {
      universalIdentifier: PL_INBOX_TAB,
      title: 'Inbox',
      position: 0,
      icon: 'IconInbox',
      layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST,
      widgets: [
        {
          universalIdentifier: PL_INBOX_WIDGET,
          title: 'WhatsApp',
          type: 'FRONT_COMPONENT',
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentUniversalIdentifier: FC_INBOX,
          },
        },
        {
          universalIdentifier: PL_INBOX_TOASTER_WIDGET,
          title: 'Notifications',
          type: 'FRONT_COMPONENT',
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentUniversalIdentifier: FC_INBOX_TOASTER,
          },
        },
      ],
    },
  ],
});
