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

/**
 * Every constant here must equal the value declared for the same variable in
 * `application-config.ts`; `config-drift.test.ts` fails the build otherwise.
 *
 * The rule exists because a mismatch is invisible in both directions: with the
 * variable set, the declaration wins and the constant is dead code; clear it
 * and behaviour jumps to a number nobody chose. Two of these were already
 * wrong — a lane share of `40` where the declaration says `0.4`, which would
 * have paced interactive sends at 800/s instead of 8/s, and a spacing eight
 * times the declared one.
 */
export const DEFAULTS = {
  defaultCountryCallingCode: '+244',
  sendThrottlePerSecond: 20,
  interactiveLaneShare: 0.4,
  recipientMinSpacingMs: 250,
  mediaAutoDownloadMaxBytes: 25 * 1024 * 1024,
  serviceWindowHours: 24,
  fepWindowHours: 72,
  optOutKeywords: ['STOP', 'SAIR', 'PARAR', 'CANCELAR'],
  optInKeywords: ['START', 'INICIAR', 'SIM'],
  campaignBatchSize: 200,
  campaignTierReservePct: 10,
  campaignFailureWindow: 100,
  campaignMaxFailureRatePct: 10,
  retentionWebhookEventDays: 30,
  retentionMessageMonths: 0,
  timelineMode: 'summary',
  sendReadReceipts: false,
  webhookStalenessHours: 24,
  autoCloseDays: 0,
  confirmationLocale: 'pt',
  optOutConfirmationPt:
    'Não voltará a receber mensagens nossas. Para voltar a receber, responda INICIAR.',
  optOutConfirmationEn: 'You will not receive further messages from us. Reply START to resume.',
  optInConfirmationPt:
    'Obrigado! Voltará a receber as nossas mensagens. Para parar, responda SAIR.',
  optInConfirmationEn: 'Thank you! You will receive our messages again. Reply STOP to unsubscribe.',
  templateSubmitHourlyCap: 90,
  rateMarketingUsd: 0.0225,
  rateUtilityUsd: 0.004,
  rateAuthenticationUsd: 0.004,
  allowApiKeyAdmin: false,
} as const;

export const config = {
  defaultCountryCallingCode: () =>
    stringVar('WA_DEFAULT_COUNTRY_CALLING_CODE', DEFAULTS.defaultCountryCallingCode),
  sendThrottlePerSecond: () =>
    numberVar('WA_SEND_THROTTLE_PER_SECOND', DEFAULTS.sendThrottlePerSecond),
  /**
   * Always a fraction of one, whichever way an operator types it.
   *
   * "Share" invites both `0.4` and `40`, and the two differ by a factor of a
   * hundred in a number that multiplies the send rate. Rather than trust the
   * label, anything above 1 is read as a percentage — so `40` and `0.4` mean
   * the same thing and neither can produce an 800/s lane.
   */
  interactiveLaneShare: () => {
    const raw = numberVar('WA_INTERACTIVE_LANE_SHARE', DEFAULTS.interactiveLaneShare);
    const fraction = raw > 1 ? raw / 100 : raw;

    return Math.min(0.9, Math.max(0.1, fraction));
  },
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
  /**
   * Off by default, and that is a product decision rather than caution: a read
   * receipt tells the customer a human has seen their message, so turning it on
   * is a promise about response times the business has to be willing to make.
   */
  sendReadReceipts: () => boolVar('WA_SEND_READ_RECEIPTS', DEFAULTS.sendReadReceipts),
  webhookStalenessHours: () =>
    numberVar('WA_WEBHOOK_STALENESS_HOURS', DEFAULTS.webhookStalenessHours),
  /** `0` disables auto-close entirely (Q-3 is still open, specs/05 §3.2). */
  autoCloseDays: () => intVar('WA_AUTO_CLOSE_DAYS', DEFAULTS.autoCloseDays),
  /**
   * Which wording a consent confirmation uses. Not inferred from the keyword the
   * contact typed: the lists are operator-editable, so "STOP" says nothing
   * reliable about the language the person reads.
   */
  confirmationLocale: () =>
    stringVar('WA_CONFIRMATION_LOCALE', DEFAULTS.confirmationLocale).toLowerCase() === 'en'
      ? 'en'
      : 'pt',
  optOutConfirmationPt: () =>
    stringVar('WA_OPT_OUT_CONFIRMATION_PT', DEFAULTS.optOutConfirmationPt),
  optOutConfirmationEn: () =>
    stringVar('WA_OPT_OUT_CONFIRMATION_EN', DEFAULTS.optOutConfirmationEn),
  optInConfirmationPt: () =>
    stringVar('WA_OPT_IN_CONFIRMATION_PT', DEFAULTS.optInConfirmationPt),
  optInConfirmationEn: () =>
    stringVar('WA_OPT_IN_CONFIRMATION_EN', DEFAULTS.optInConfirmationEn),
  /**
   * Meta allows 100 template creations per WABA per hour and answers the 101st
   * with an opaque error. Refusing locally at 90 leaves headroom and produces a
   * message that says what to do.
   */
  templateSubmitHourlyCap: () =>
    intVar('WA_TEMPLATE_SUBMIT_HOURLY_CAP', DEFAULTS.templateSubmitHourlyCap),
  /**
   * Off by default (SEC-5). An API key carries no readable role, so granting it
   * admin authority is a decision a workspace makes explicitly, not a default.
   */
  allowApiKeyAdmin: () => boolVar('WA_ALLOW_API_KEY_ADMIN', DEFAULTS.allowApiKeyAdmin),
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
