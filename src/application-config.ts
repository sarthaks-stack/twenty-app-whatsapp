import { defineApplication, FieldType } from 'twenty-sdk/define';

import {
  APP_DESCRIPTION,
  APP_DISPLAY_NAME,
  APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

/**
 * Meta credentials are `serverVariables` marked secret (AR-2, SEC-1): Twenty
 * encrypts them at rest, injects them into logic functions as `process.env`, and
 * never sends them to front components. They are read only through
 * `requireSecret()`, which fails closed — there is no default, no `?? ''`, and
 * no "development fallback".
 *
 * Everything operationally tunable is an `applicationVariable` rather than a
 * code literal (NFR-M1). Values always arrive as strings, so every read parses
 * explicitly.
 *
 * Per-account settings that must differ between numbers (throttle, calling code,
 * auto-creation, test flag) are record fields on `whatsappAccount`, not
 * variables — resolution is account field → application variable → constant.
 */
export default defineApplication({
  universalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
  displayName: APP_DISPLAY_NAME,
  description: APP_DESCRIPTION,
  logo: 'public/logo.svg',
  category: 'Communication',
  serverVariables: {
    META_APP_ID: {
      description:
        'Meta app ID (App Dashboard → Settings → Basic). Public in OAuth flows; shown in the settings health panel.',
      isSecret: false,
      isRequired: true,
      type: FieldType.TEXT,
    },
    META_APP_SECRET: {
      description:
        'Meta App Secret. Used to verify the X-Hub-Signature-256 on every webhook, over the raw request body. Stored encrypted; never exposed in API responses.',
      isSecret: true,
      isRequired: true,
      type: FieldType.TEXT,
    },
    META_ACCESS_TOKEN: {
      description:
        'System User token with exactly whatsapp_business_messaging and whatsapp_business_management. Rotating it is a settings edit — no redeploy, no downtime.',
      isSecret: true,
      isRequired: true,
      type: FieldType.TEXT,
    },
    META_VERIFY_TOKEN: {
      description:
        'Random string echoed during Meta’s GET verification handshake. Generate with `openssl rand -hex 32` and paste the same value into the Meta webhook configuration.',
      isSecret: true,
      isRequired: true,
      type: FieldType.TEXT,
    },
  },
  applicationVariables: {
    META_GRAPH_VERSION: {
      universalIdentifier: '5c2f5cf1-a3a6-4b93-9c53-5b1ef0f7d2a1',
      description: 'Pinned Graph API version. Review at least annually — versions live ~2 years.',
      value: 'v26.0',
      type: FieldType.TEXT,
    },
    WA_DEFAULT_COUNTRY_CALLING_CODE: {
      universalIdentifier: '0b8dbe0c-2f2e-4a35-8b64-3c6d0d21f4a7',
      description: 'Applied when normalising nationally-formatted numbers (FR-CID-1).',
      value: '+244',
      type: FieldType.TEXT,
    },
    WA_SEND_THROTTLE_PER_SECOND: {
      universalIdentifier: 'a2f2f0f7-3f5f-42e6-9f2f-6a4a8f0e5d31',
      description: 'Default per-number send ceiling, kept well below Meta’s 80/s (AR-12).',
      value: '20',
      type: FieldType.NUMBER,
    },
    WA_INTERACTIVE_LANE_SHARE: {
      universalIdentifier: 'd2c0a4b6-7f1a-4a2b-9e8c-1d5f3a7b9c02',
      description:
        'Share of the throttle reserved for interactive 1:1 sends, so a running campaign can never delay a rep (AR-19, NFR-S5).',
      value: '0.4',
      type: FieldType.NUMBER,
    },
    WA_RECIPIENT_MIN_SPACING_MS: {
      universalIdentifier: '6a1c9f4d-8b2e-4c7a-9d13-2e8f5b0a7c64',
      description: 'Minimum gap between two sends to the same contact, avoiding Meta error 131056.',
      value: '250',
      type: FieldType.NUMBER,
    },
    WA_MEDIA_AUTO_DOWNLOAD_MAX_BYTES: {
      universalIdentifier: 'f4b7d2a1-5c93-4e6f-8a20-9b1d3c7e5f48',
      description:
        'Inbound media at or under this size is downloaded automatically; larger media is stored deferred with a download-on-demand action (specs/00 D-8).',
      value: '26214400',
      type: FieldType.NUMBER,
    },
    WA_SERVICE_WINDOW_HOURS: {
      universalIdentifier: '3e5a8c02-9d47-4b1f-8e6a-7c2b4d9f1a53',
      description: 'Customer service window. Meta’s rule is 24h; configurable for staging tests.',
      value: '24',
      type: FieldType.NUMBER,
    },
    WA_FEP_WINDOW_HOURS: {
      universalIdentifier: '8c4f1b7e-2a69-4d35-9f8b-0e3a6c5d2b91',
      description: 'Free-entry-point window for Click-to-WhatsApp conversations (FR-IN-6).',
      value: '72',
      type: FieldType.NUMBER,
    },
    WA_OPT_OUT_KEYWORDS: {
      universalIdentifier: '1d7e3a9c-4f82-4b56-9c1e-8a5d2f7b3e60',
      description:
        'Exact-token matches (accent- and case-insensitive) that opt a contact out and trigger one confirmation (FR-CON-3).',
      value: ['STOP', 'SAIR', 'PARAR', 'CANCELAR'],
      type: FieldType.ARRAY,
    },
    WA_OPT_IN_KEYWORDS: {
      universalIdentifier: '9b2c5d8f-3e17-4a94-8d6b-5f1c0a3e7d24',
      description: 'Exact-token matches that opt a contact back in.',
      value: ['START', 'INICIAR', 'SIM'],
      type: FieldType.ARRAY,
    },
    WA_POLL_INTERVAL_THREAD_MS: {
      universalIdentifier: '7f3a1c5e-8d24-4b60-9e17-3c8b5a2d6f09',
      description: 'Chat refresh while a conversation is open and focused (specs/00 D-6).',
      value: '3000',
      type: FieldType.NUMBER,
    },
    WA_POLL_INTERVAL_INBOX_MS: {
      universalIdentifier: '2a8d6b3f-1c95-4e72-8b40-6d9f3a1c5e87',
      description: 'Inbox list refresh while focused.',
      value: '8000',
      type: FieldType.NUMBER,
    },
    WA_POLL_INTERVAL_BLURRED_MS: {
      universalIdentifier: 'c5e2f9a7-6b30-4d18-9a52-1f7c4b8e3d06',
      description: 'Refresh interval once the window loses focus.',
      value: '20000',
      type: FieldType.NUMBER,
    },
    WA_CAMPAIGN_BATCH_SIZE: {
      universalIdentifier: 'e9c1a7d5-4f83-462b-8d09-7a3e5c2b1f48',
      description: 'Recipients claimed per runner tick (AR-20).',
      value: '200',
      type: FieldType.NUMBER,
    },
    WA_CAMPAIGN_TIER_RESERVE_PCT: {
      universalIdentifier: '4b7d0e2a-9c56-4318-8f7b-2e5a1d9c6f03',
      description:
        'Share of the daily messaging tier held back for 1:1 sends, so a campaign cannot consume the whole allowance (AR-21).',
      value: '10',
      type: FieldType.NUMBER,
    },
    WA_CAMPAIGN_FAILURE_WINDOW: {
      universalIdentifier: 'a3f6c9b2-5d47-40e1-9c83-6b2f8d1a5e79',
      description: 'How many terminal outcomes the circuit breaker considers (AR-22).',
      value: '100',
      type: FieldType.NUMBER,
    },
    WA_CAMPAIGN_MAX_FAILURE_RATE_PCT: {
      universalIdentifier: '0d5b8e1c-7a24-4f93-8e6d-3c9a2f7b4d15',
      description: 'Failure rate over that window which auto-pauses a campaign (AR-22).',
      value: '10',
      type: FieldType.NUMBER,
    },
    WA_RETENTION_WEBHOOK_EVENT_DAYS: {
      universalIdentifier: 'b8e4a2d6-1f75-4c39-9b02-5d7c3a8f6e14',
      description:
        'Raw webhook log retention. Hard floor of 7 days: Meta retries for 7 days and offers no replay API afterwards, so this table is the only source for reprocessing.',
      value: '30',
      type: FieldType.NUMBER,
    },
    WA_RETENTION_MESSAGE_MONTHS: {
      universalIdentifier: '6c9f2b7a-3e18-4d54-8a71-9b4e0c2d5f83',
      description:
        'Months after which message bodies and media are purged; 0 keeps everything. Purging blanks content but keeps status and cost data, so reporting survives (SEC-9).',
      value: '0',
      type: FieldType.NUMBER,
    },
    WA_TIMELINE_MODE: {
      universalIdentifier: 'f1a7c3e9-8b52-4670-9d34-2a6f5c1b8e07',
      description:
        'How much WhatsApp activity reaches the Person timeline. `summary` (default) records the first message of a conversation, daily firsts, template sends, failures, consent and assignment changes — `all` would add ~50 000 rows/day at the design volume and make the timeline unusable (specs/09 §4.2).',
      value: 'summary',
      type: FieldType.SELECT,
      options: [
        { label: 'All messages', value: 'all' },
        { label: 'Summary', value: 'summary' },
        { label: 'Off', value: 'off' },
      ],
    },
    WA_RATE_MARKETING_USD: {
      universalIdentifier: '5e8b1d4f-2c96-4a73-8f01-7d3a9e6c2b58',
      description:
        'Per delivered marketing message, Rest-of-Africa. Third-party mirrored — verify against Meta’s official rate card (Q-1).',
      value: '0.0225',
      type: FieldType.NUMBER,
    },
    WA_RATE_UTILITY_USD: {
      universalIdentifier: 'c2d7f5a8-9e31-4b64-8c07-1a5e3b9d6f42',
      description: 'Per delivered utility message outside the service window.',
      value: '0.0040',
      type: FieldType.NUMBER,
    },
    WA_RATE_AUTHENTICATION_USD: {
      universalIdentifier: '9a4e7c2b-6f18-4d05-8b93-5c1f2a7e4d69',
      description: 'Per delivered authentication message.',
      value: '0.0040',
      type: FieldType.NUMBER,
    },
    WA_PROVIDER: {
      universalIdentifier: '7d1c4a9e-5b83-4267-9f0a-3e8b6d2c5a71',
      description:
        'Selects the messaging provider. Only the direct Cloud API driver ships; the seam exists so a BSP driver or a future native channel can replace the transport without touching business logic (AR-18).',
      value: 'cloud-api',
      type: FieldType.SELECT,
      options: [{ label: 'Meta Cloud API', value: 'cloud-api' }],
    },
  },
});
