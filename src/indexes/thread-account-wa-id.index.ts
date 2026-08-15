import { defineIndex } from 'twenty-sdk/define';

import { fieldId, indexFieldId } from 'src/constants/field-identifiers';
import { IDX_THREAD_ACCOUNT_WAID, OBJ_THREAD } from 'src/constants/universal-identifiers';

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

/** FR-THR-1 — one conversation per (account, waId). This is the guarantee that a template send never spawns a duplicate conversation, not a performance hint. */
export default defineIndex({
  universalIdentifier: IDX_THREAD_ACCOUNT_WAID,
  objectUniversalIdentifier: OBJ_THREAD,
  isUnique: true,
  fields: [
    {
      universalIdentifier: indexFieldId(OBJ_THREAD, 'accountWaId', 'account'),
      fieldUniversalIdentifier: fieldId(OBJ_THREAD, 'account'),
    },
    {
      universalIdentifier: indexFieldId(OBJ_THREAD, 'accountWaId', 'waId'),
      fieldUniversalIdentifier: fieldId(OBJ_THREAD, 'waId'),
    },
  ],
});
