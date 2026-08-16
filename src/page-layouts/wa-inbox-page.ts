import { definePageLayout, PageLayoutTabLayoutMode, PageLayoutType } from 'twenty-sdk/define';

import {
  FC_INBOX,
  PL_INBOX,
  PL_INBOX_TAB,
  PL_INBOX_WIDGET,
} from '../constants/universal-identifiers';

/**
 * The page the Inbox navigation item opens (FR-UI-2).
 *
 * One widget: the inbox owns its whole surface, including its own two-pane
 * split. A page layout with several widgets would divide a width the component
 * already divides, and neither would know about the other.
 *
 * **The toaster used to be a second, `isHeadless` widget here, and is not any
 * more.** `isHeadless` stops the component drawing; it does not stop the page
 * layout drawing a card around it, so the inbox shipped with an empty box
 * titled "Notifications" beneath the conversation list. D-10 layer 2 still runs
 * on this page — `<InboxView>` mounts `<InboundToaster>` itself.
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
      ],
    },
  ],
});
