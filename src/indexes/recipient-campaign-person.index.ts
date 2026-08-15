import { defineIndex } from 'twenty-sdk/define';

import { fieldId, indexFieldId } from 'src/constants/field-identifiers';
import { IDX_RECIPIENT_CAMPAIGN_PERSON, OBJ_CAMPAIGN_RECIPIENT } from 'src/constants/universal-identifiers';

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

/** AR-20 — the structural guarantee that no one is messaged twice by one campaign, independent of the claim logic and of WAMID uniqueness. */
export default defineIndex({
  universalIdentifier: IDX_RECIPIENT_CAMPAIGN_PERSON,
  objectUniversalIdentifier: OBJ_CAMPAIGN_RECIPIENT,
  isUnique: true,
  fields: [
    {
      universalIdentifier: indexFieldId(OBJ_CAMPAIGN_RECIPIENT, 'campaignPerson', 'campaign'),
      fieldUniversalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'campaign'),
    },
    {
      universalIdentifier: indexFieldId(OBJ_CAMPAIGN_RECIPIENT, 'campaignPerson', 'person'),
      fieldUniversalIdentifier: fieldId(OBJ_CAMPAIGN_RECIPIENT, 'person'),
    },
  ],
});
