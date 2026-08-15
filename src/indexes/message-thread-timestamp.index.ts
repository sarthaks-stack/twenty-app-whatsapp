import { defineIndex } from 'twenty-sdk/define';

import { fieldId, indexFieldId } from 'src/constants/field-identifiers';
import { IDX_MESSAGE_THREAD_TS, OBJ_MESSAGE } from 'src/constants/universal-identifiers';

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

/** NFR-P4 — chat pagination, the only hot query on the largest table (~18M rows/year at the design volume). */
export default defineIndex({
  universalIdentifier: IDX_MESSAGE_THREAD_TS,
  objectUniversalIdentifier: OBJ_MESSAGE,
  fields: [
    {
      universalIdentifier: indexFieldId(OBJ_MESSAGE, 'threadTimestamp', 'thread'),
      fieldUniversalIdentifier: fieldId(OBJ_MESSAGE, 'thread'),
    },
    {
      universalIdentifier: indexFieldId(OBJ_MESSAGE, 'threadTimestamp', 'waTimestamp'),
      fieldUniversalIdentifier: fieldId(OBJ_MESSAGE, 'waTimestamp'),
    },
  ],
});
