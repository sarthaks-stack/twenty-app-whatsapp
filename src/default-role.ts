import { defineApplicationRole } from 'twenty-sdk/define';

import { APP_DISPLAY_NAME, DEFAULT_ROLE_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

/**
 * The identity the app's own logic functions run as.
 *
 * Scoped down from the scaffolded template: the functions need to write their
 * own objects, read and update Person (contact auto-creation and the consent
 * field), read workspace members, and write timeline activities.
 *
 * Deliberately withheld: `canDestroyAllObjectRecords` — GDPR erasure (SEC-8) is
 * an explicit, audited routine, not something any handler can do by accident —
 * and `canUpdateAllSettings`.
 */
export default defineApplicationRole({
  universalIdentifier: DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  label: `${APP_DISPLAY_NAME} function role`,
  description: `Identity used by ${APP_DISPLAY_NAME} logic functions when reading and writing workspace records`,
  canReadAllObjectRecords: true,
  canUpdateAllObjectRecords: true,
  canSoftDeleteAllObjectRecords: true,
  canDestroyAllObjectRecords: false,
  canUpdateAllSettings: false,
});
