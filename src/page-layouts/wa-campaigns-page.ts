import { definePageLayout, PageLayoutTabLayoutMode, PageLayoutType } from 'twenty-sdk/define';

import {
  FC_CAMPAIGNS,
  PL_CAMPAIGNS,
  PL_CAMPAIGNS_TAB,
  PL_CAMPAIGNS_WIDGET,
} from '../constants/universal-identifiers';

/** The page the Campaigns navigation item opens (FR-CAM-10). */
export default definePageLayout({
  universalIdentifier: PL_CAMPAIGNS,
  name: 'WhatsApp Campaigns',
  type: PageLayoutType.STANDALONE_PAGE,
  tabs: [
    {
      universalIdentifier: PL_CAMPAIGNS_TAB,
      title: 'Campaigns',
      position: 0,
      icon: 'IconSend',
      layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST,
      widgets: [
        {
          universalIdentifier: PL_CAMPAIGNS_WIDGET,
          title: 'Campaigns',
          type: 'FRONT_COMPONENT',
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentUniversalIdentifier: FC_CAMPAIGNS,
          },
        },
      ],
    },
  ],
});
