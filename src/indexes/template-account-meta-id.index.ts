import { defineIndex } from 'twenty-sdk/define';

import { fieldId, indexFieldId } from 'src/constants/field-identifiers';
import { IDX_TEMPLATE_ACCOUNT_META, OBJ_TEMPLATE } from 'src/constants/universal-identifiers';

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

/** Template sync upserts by (account, metaTemplateId) on every 6-hourly run. */
export default defineIndex({
  universalIdentifier: IDX_TEMPLATE_ACCOUNT_META,
  objectUniversalIdentifier: OBJ_TEMPLATE,
  isUnique: true,
  fields: [
    {
      universalIdentifier: indexFieldId(OBJ_TEMPLATE, 'accountMeta', 'account'),
      fieldUniversalIdentifier: fieldId(OBJ_TEMPLATE, 'account'),
    },
    {
      universalIdentifier: indexFieldId(OBJ_TEMPLATE, 'accountMeta', 'metaTemplateId'),
      fieldUniversalIdentifier: fieldId(OBJ_TEMPLATE, 'metaTemplateId'),
    },
  ],
});
