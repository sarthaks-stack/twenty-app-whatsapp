/**
 * Application-variable reads (NFR-M1).
 *
 * Resolution order is **account field → application variable → constant**
 * (specs/01 §4.2). Anything that must differ between numbers — throttle,
 * calling code, auto-creation, test flag — is a record field, because two
 * numbers in one workspace share the variables but not the settings.
 *
 * Values always arrive as strings, so every read parses explicitly and falls
 * back to the constant on anything unparseable. A malformed variable degrades
 * to a documented default rather than producing `NaN` two layers downstream.
 */

const raw = (name: string): string | undefined => {
  const value = process.env[name];

  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
};

export const stringVar = (name: string, fallback: string): string => raw(name) ?? fallback;

export const numberVar = (name: string, fallback: number): number => {
  const value = raw(name);
  if (value === undefined) return fallback;

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
};

export const intVar = (name: string, fallback: number): number => {
  const parsed = numberVar(name, fallback);

  return Number.isInteger(parsed) ? parsed : Math.trunc(parsed);
};

export const boolVar = (name: string, fallback: boolean): boolean => {
  const value = raw(name)?.toLowerCase();
  if (value === undefined) return fallback;

  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;

  return fallback;
};

/** Comma-separated lists, trimmed, empties dropped. */
export const listVar = (name: string, fallback: string[]): string[] => {
  const value = raw(name);
  if (value === undefined) return fallback;

  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length === 0 ? fallback : items;
};

export const DEFAULTS = {
  defaultCountryCallingCode: '+244',
  sendThrottlePerSecond: 20,
  interactiveLaneShare: 40,
  recipientMinSpacingMs: 2_000,
  mediaAutoDownloadMaxBytes: 25 * 1024 * 1024,
  serviceWindowHours: 24,
  fepWindowHours: 72,
  optOutKeywords: ['STOP', 'SAIR', 'PARAR', 'CANCELAR'],
  optInKeywords: ['START', 'INICIAR', 'SIM'],
  campaignBatchSize: 100,
  campaignTierReservePct: 10,
  campaignFailureWindow: 100,
  campaignMaxFailureRatePct: 10,
  retentionWebhookEventDays: 30,
  retentionMessageMonths: 24,
  timelineMode: 'SUMMARY',
  rateMarketingUsd: 0.0225,
  rateUtilityUsd: 0.004,
  rateAuthenticationUsd: 0.004,
} as const;

export const config = {
  defaultCountryCallingCode: () =>
    stringVar('WA_DEFAULT_COUNTRY_CALLING_CODE', DEFAULTS.defaultCountryCallingCode),
  sendThrottlePerSecond: () =>
    numberVar('WA_SEND_THROTTLE_PER_SECOND', DEFAULTS.sendThrottlePerSecond),
  interactiveLaneShare: () =>
    numberVar('WA_INTERACTIVE_LANE_SHARE', DEFAULTS.interactiveLaneShare),
  recipientMinSpacingMs: () =>
    numberVar('WA_RECIPIENT_MIN_SPACING_MS', DEFAULTS.recipientMinSpacingMs),
  mediaAutoDownloadMaxBytes: () =>
    numberVar('WA_MEDIA_AUTO_DOWNLOAD_MAX_BYTES', DEFAULTS.mediaAutoDownloadMaxBytes),
  serviceWindowHours: () => numberVar('WA_SERVICE_WINDOW_HOURS', DEFAULTS.serviceWindowHours),
  fepWindowHours: () => numberVar('WA_FEP_WINDOW_HOURS', DEFAULTS.fepWindowHours),
  optOutKeywords: () => listVar('WA_OPT_OUT_KEYWORDS', [...DEFAULTS.optOutKeywords]),
  optInKeywords: () => listVar('WA_OPT_IN_KEYWORDS', [...DEFAULTS.optInKeywords]),
  campaignBatchSize: () => intVar('WA_CAMPAIGN_BATCH_SIZE', DEFAULTS.campaignBatchSize),
  campaignTierReservePct: () =>
    numberVar('WA_CAMPAIGN_TIER_RESERVE_PCT', DEFAULTS.campaignTierReservePct),
  campaignFailureWindow: () =>
    intVar('WA_CAMPAIGN_FAILURE_WINDOW', DEFAULTS.campaignFailureWindow),
  campaignMaxFailureRatePct: () =>
    numberVar('WA_CAMPAIGN_MAX_FAILURE_RATE_PCT', DEFAULTS.campaignMaxFailureRatePct),
  /**
   * Meta retries for 7 days, and this table is the only way to reprocess
   * history — a retention shorter than the retry window would discard events
   * Meta is still resending (specs/02 §8).
   */
  retentionWebhookEventDays: () =>
    Math.max(7, intVar('WA_RETENTION_WEBHOOK_EVENT_DAYS', DEFAULTS.retentionWebhookEventDays)),
  retentionMessageMonths: () =>
    intVar('WA_RETENTION_MESSAGE_MONTHS', DEFAULTS.retentionMessageMonths),
  timelineMode: () => stringVar('WA_TIMELINE_MODE', DEFAULTS.timelineMode).toUpperCase(),
  rates: () => ({
    marketingUsd: numberVar('WA_RATE_MARKETING_USD', DEFAULTS.rateMarketingUsd),
    utilityUsd: numberVar('WA_RATE_UTILITY_USD', DEFAULTS.rateUtilityUsd),
    authenticationUsd: numberVar('WA_RATE_AUTHENTICATION_USD', DEFAULTS.rateAuthenticationUsd),
  }),
} as const;

/**
 * The account field wins when it is set. Written as a helper rather than
 * repeated inline so the precedence is stated once — a handler that read the
 * variable directly would silently ignore a per-number setting.
 */
export const forAccount = <T>(accountValue: T | null | undefined, fallback: () => T): T =>
  accountValue === null || accountValue === undefined ? fallback() : accountValue;
