import { defineFrontComponent } from 'twenty-sdk/define';

import { CampaignsView } from '../components/campaigns/CampaignsView';
import { FC_CAMPAIGNS } from '../constants/universal-identifiers';

/**
 * The campaigns page (FR-CAM-1, FR-CAM-10).
 *
 * Agents reach it read-only — the list and the pre-flight numbers are not a
 * privileged view, and a rep who can see what a campaign will say is better
 * placed to notice it is wrong. Every button that writes is hidden without
 * `canManageCampaigns` and refused again by the route (SEC-12).
 */
const WaCampaigns = () => <CampaignsView />;

export default defineFrontComponent({
  universalIdentifier: FC_CAMPAIGNS,
  name: 'wa-campaigns',
  description: 'WhatsApp campaigns: the list, the builder, the pre-flight and the controls.',
  component: WaCampaigns,
});
