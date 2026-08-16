import {
  definePageLayoutTab,
  PageLayoutTabLayoutMode,
  STANDARD_PAGE_LAYOUT,
} from 'twenty-sdk/define';

import {
  FC_PERSON_THREAD,
  PLT_PERSON_WHATSAPP,
  PLT_PERSON_WHATSAPP_WIDGET,
} from '../constants/universal-identifiers';

/**
 * The WhatsApp tab on every Person record (FR-UI-1).
 *
 * `position: 500` puts it after Twenty's own tabs rather than in front of them.
 * An app that installs itself as the first thing a user sees on a record they
 * opened for another reason has decided something that is the workspace's to
 * decide.
 */
export default definePageLayoutTab({
  universalIdentifier: PLT_PERSON_WHATSAPP,
  pageLayoutUniversalIdentifier: STANDARD_PAGE_LAYOUT.personRecordPage.universalIdentifier,
  title: 'WhatsApp',
  position: 500,
  icon: 'IconBrandWhatsapp',
  layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST,
  widgets: [
    {
      universalIdentifier: PLT_PERSON_WHATSAPP_WIDGET,
      title: 'WhatsApp',
      type: 'FRONT_COMPONENT',
      configuration: {
        configurationType: 'FRONT_COMPONENT',
        frontComponentUniversalIdentifier: FC_PERSON_THREAD,
      },
    },
  ],
});
