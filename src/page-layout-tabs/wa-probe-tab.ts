import {
  definePageLayoutTab,
  PageLayoutTabLayoutMode,
  STANDARD_PAGE_LAYOUT,
} from 'twenty-sdk/define';

/**
 * Temporary — the surface probe P-6 is measured on.
 *
 * A record-page widget, not a standalone page, because that is the constrained
 * case: FR-UI-1 puts the chat inside a Person tab, where the height is the
 * host's to decide and the component may not scroll the page (specs/00 D-7).
 * Delete with `src/front-components/wa-probe.tsx`.
 */
export default definePageLayoutTab({
  universalIdentifier: '1056eda7-661c-46ce-b610-33d1b2e7934b',
  pageLayoutUniversalIdentifier: STANDARD_PAGE_LAYOUT.personRecordPage.universalIdentifier,
  title: 'WA Probe',
  position: 900,
  icon: 'IconFlask',
  layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST,
  widgets: [
    {
      universalIdentifier: '857d1bb6-81ca-460c-bd12-f5e16bb3e838',
      title: 'Probe P-6',
      type: 'FRONT_COMPONENT',
      configuration: {
        configurationType: 'FRONT_COMPONENT',
        frontComponentUniversalIdentifier: '4a7d29b5-b12b-41ca-b22d-2a0f710f84b4',
      },
    },
  ],
});
