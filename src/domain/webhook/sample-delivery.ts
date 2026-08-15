import type { MetaWebhookBody } from './types';

/**
 * Detects the canned payload Meta sends from the "Test" button in
 * App Dashboard → WhatsApp → Configuration → Webhook fields.
 *
 * It is genuinely signed with the App Secret and arrives from
 * `facebookexternalua`, so it proves the handshake, the tunnel and the HMAC
 * path — but it describes a message that never existed:
 *
 *   entry[].id        "0"
 *   phone_number_id   "123456123"
 *   messages[].id     "ABGGFlA5Fpa"   (a real one is prefixed "wamid.")
 *   timestamp         1504902988      (2017-09-08)
 *
 * Recorded as an `inbound-text` fixture it would hand workstream B a WAMID that
 * cannot collide, a routing id that matches no account, and a timestamp that
 * puts every service-window calculation nine years in the past. It is the first
 * thing anyone clicks, so the harness recognises it explicitly rather than
 * trusting each engineer to notice.
 */

const SAMPLE_PHONE_NUMBER_IDS = new Set(['123456123']);

export const isMetaSampleDelivery = (body: MetaWebhookBody): boolean => {
  const entries = body.entry ?? [];
  if (entries.length === 0) return false;

  return entries.some((entry) => {
    if (entry.id === '0') return true;

    return (entry.changes ?? []).some((change) => {
      const value = change.value ?? {};

      const phoneNumberId = value.metadata?.phone_number_id;
      if (phoneNumberId !== undefined && SAMPLE_PHONE_NUMBER_IDS.has(phoneNumberId)) {
        return true;
      }

      // Every id the live API issues is prefixed `wamid.`; the sample's is not.
      const hasUnprefixedMessageId = (value.messages ?? []).some(
        (message) => message.id !== undefined && !message.id.startsWith('wamid.'),
      );
      const hasUnprefixedStatusId = (value.statuses ?? []).some(
        (status) => status.id !== undefined && !status.id.startsWith('wamid.'),
      );

      return hasUnprefixedMessageId || hasUnprefixedStatusId;
    });
  });
};
