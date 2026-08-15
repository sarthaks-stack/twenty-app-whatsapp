import { SystemPermissionFlag, defineApplicationRole } from 'twenty-sdk/define';

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
 *
 * **`UPLOAD_FILE` / `DOWNLOAD_FILE` are granted individually.** The media
 * worker attaches inbound WhatsApp media to `whatsappMessage.mediaFile`, and
 * without them the upload fails with "Entity performing the request does not
 * have permission" — a message that names neither the permission nor the file.
 * Twenty offers these as discrete flags, so the alternative of switching on
 * `canUpdateAllSettings` (which would also hand every handler the data model,
 * roles and billing) was not needed and would have been a poor trade for one
 * file upload.
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
  permissionFlagUniversalIdentifiers: [
    SystemPermissionFlag.UPLOAD_FILE,
    SystemPermissionFlag.DOWNLOAD_FILE,
  ],
});
