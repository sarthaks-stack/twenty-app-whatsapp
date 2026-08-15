import { defineIndex } from 'twenty-sdk/define';

import { fieldId, indexFieldId } from 'src/constants/field-identifiers';
import { IDX_RECIPIENT_CAMPAIGN_STATUS, OBJ_CAMPAIGN_RECIPIENT } from 'src/constants/universal-identifiers';

/**
 * Composite indexes are one file per index: the SDK discovers entities by
 * default export, so several `defineIndex` calls sharing a module are silently
 * dropped from the manifest — caught by inspecting the built manifest, not by
 * typecheck.
 *
 * Single-column uniqueness (whatsappAccount.phoneNumberId, whatsappMessage.wamid,
 * whatsappWebhookEvent.dedupKey) is declared with `isUnique: true` on the field,
 * which provisions the index; declaring it again here would define the same
 * constraint twice.
 */

/** The runner's batch-claim query and the live stats aggregation (AR-20, FR-CAM-10). */
export default defineIndex({
  universalIdentifier: IDX_RECIPIENT_CAMPAIGN_STATUS,
  objectUniversalIdentifier: OBJ_CAMPAIGN_RECIPIENT,
  fields: [
    {
      universalIdentifier: indexFieldId(OBJ_CAMPAIGN_RECIPIENT, 'campaignStatus', 'campaign'),
      fieldUniversalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'campaign'),
    },
    {
      universalIdentifier: indexFieldId(OBJ_CAMPAIGN_RECIPIENT, 'campaignStatus', 'status'),
      fieldUniversalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'status'),
    },
  ],
});
