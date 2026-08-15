/**
 * The fixture set a Meta **test** number and one real device can actually
 * produce. Drives the live coverage checklist the capture server prints after
 * every delivery.
 *
 * Mirrors specs/12-testing.md §4, minus the five shapes no test number can
 * generate on demand — those are listed in UNCAPTURABLE and must be
 * hand-written and flagged as synthetic.
 */

export type RequiredFixture = {
  slug: string;
  /** What to do on the device to produce it. */
  how: string;
};

export const REQUIRED_FIXTURES: RequiredFixture[] = [
  { slug: 'inbound-text', how: 'Send a plain text message' },
  {
    slug: 'inbound-text-reply',
    how: 'Long-press one of your own messages → Reply, then send text',
  },
  { slug: 'inbound-image', how: 'Send a photo (add a caption)' },
  { slug: 'inbound-video', how: 'Send a short video' },
  { slug: 'inbound-audio-voice', how: 'Hold the mic button and record a voice note' },
  { slug: 'inbound-document', how: 'Send a PDF' },
  { slug: 'inbound-sticker', how: 'Send a sticker' },
  { slug: 'inbound-location', how: 'Attach → Location → Send your current location' },
  { slug: 'inbound-contacts', how: 'Attach → Contact → share any contact card' },
  { slug: 'inbound-reaction-add', how: 'React to a business message with any emoji' },
  { slug: 'inbound-reaction-remove', how: 'Remove that same reaction' },
  {
    slug: 'inbound-interactive-button-reply',
    how: 'Send an interactive button message from the CRM/API, then tap a button',
  },
  {
    slug: 'inbound-interactive-list-reply',
    how: 'Send an interactive list message, then choose a row',
  },
  { slug: 'status-sent', how: 'Automatic — send any message from the API' },
  { slug: 'status-delivered', how: 'Automatic — device online' },
];

/**
 * Producible in principle, but not reliably from one test device. Each was
 * attempted on 2026-08-15 and the reason it failed is recorded — these are
 * findings about WhatsApp, not gaps in the harness.
 */
export const CONDITIONAL: (RequiredFixture & { why: string })[] = [
  {
    slug: 'inbound-audio',
    how: 'Forward an audio message from another WhatsApp chat',
    why:
      'Sending an .mp3 through the document picker does NOT produce type:audio — WhatsApp keeps ' +
      'it as type:document with mime_type audio/mpeg (observed). type:audio essentially only ' +
      'arrives as a voice note (voice:true) or forwarded audio media.',
  },
  {
    slug: 'status-read',
    how: 'Open the chat on a device that has read receipts enabled',
    why:
      'WhatsApp users can disable read receipts (Settings → Privacy). When they do, the read ' +
      'status is never emitted for that contact — no error, it simply never arrives. Confirmed ' +
      'on the project test device.',
  },
];

/**
 * Not producible with a test number, and not covered by Meta's Test button.
 * Hand-write from specs/appendix-a-meta-api.md §5 and mark `"synthetic": true` —
 * synthetic fixtures are the ones that turn out subtly wrong, so they must be
 * visibly distinguishable from captures.
 */
export const UNCAPTURABLE: RequiredFixture[] = [
  { slug: 'inbound-text-referral', how: 'Requires a live Click-to-WhatsApp ad' },
  { slug: 'inbound-interactive-nfm-reply', how: 'Requires a published WhatsApp Flow' },
  { slug: 'status-failed-131049', how: 'Requires hitting the per-user marketing cap' },
];

/**
 * Meta's App Dashboard → WhatsApp → Configuration → **Test** button emits an
 * authoritative, correctly-signed sample for every subscribed field. For the
 * seven non-message fields that is strictly better than hand-writing from prose,
 * and it is how the `sample-*` fixtures were obtained on 2026-08-15.
 *
 * They remain samples, not captures: the ids, phone numbers and timestamps are
 * fabricated, so they exercise *parsing and routing* only — never matching,
 * dedup or window arithmetic. `isMetaSampleDelivery` enforces the distinction
 * and the harness prefixes their slug with `sample-`.
 */
export const DASHBOARD_TEST_SAMPLES: string[] = [
  'sample-template-status-approved',
  'sample-template-quality-yellow',
  'sample-template-components-update',
  'sample-account-update-verified-account',
  'sample-account-review-approved',
  'sample-phone-quality-onboarding',
  'sample-phone-name-approved',
];
