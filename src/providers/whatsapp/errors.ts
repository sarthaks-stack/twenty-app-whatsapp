/**
 * The Meta error catalogue (appendix B, FR-OUT-4) as data.
 *
 * The table is the contract between "Meta said no" and "the app did something
 * sensible about it": whether to retry, whether to fail the message, whether to
 * pause a whole campaign, and whether a human needs telling. Prose in a runbook
 * cannot do that; a lookup can.
 *
 * User-facing copy deliberately lives in the front end (01 §7) — this module
 * produces classifications and internal codes only, so a translation change is
 * never a server deploy.
 */

export const ERROR_CLASS = {
  RETRYABLE_BACKOFF: 'retryable_backoff',
  RETRYABLE_AFTER_REFRESH: 'retryable_after_refresh',
  TERMINAL_RECIPIENT: 'terminal_recipient',
  TERMINAL_CONTENT: 'terminal_content',
  TERMINAL_UNKNOWN: 'terminal_unknown',
} as const;
export type ErrorClass = (typeof ERROR_CLASS)[keyof typeof ERROR_CLASS];

/** Consequences beyond the message itself. Read by the sender and the runner. */
export type ErrorEffect = {
  /** Mark the account `error` and stop sending on it. */
  accountError?: true;
  /** Pause every running campaign using this template — the mapping is wrong for everyone. */
  pauseCampaign?: true;
  /** A campaign recipient is `skipped`, not `failed`, and is never retried. */
  campaignSkip?: true;
  /** Un-publish the template and re-sync from Meta. */
  unpublishTemplate?: true;
  /** Raise an admin alert. */
  alertAdmin?: true;
  /** Widen this recipient's send spacing for the rest of the run. */
  widenSpacing?: true;
};

export type ErrorCatalogEntry = {
  code: number;
  meaning: string;
  class: ErrorClass;
  effect: ErrorEffect;
};

const ENTRIES: ErrorCatalogEntry[] = [
  /**
   * 131047 should be impossible: the policy gate is supposed to pre-empt it.
   * Seeing it means the gate has a bug, which is why it alerts rather than
   * merely failing the message.
   */
  {
    code: 131047,
    meaning: 'Re-engagement required — outside the 24h window',
    class: ERROR_CLASS.TERMINAL_RECIPIENT,
    effect: { alertAdmin: true },
  },
  {
    code: 131026,
    meaning: 'Recipient not on WhatsApp or undeliverable',
    class: ERROR_CLASS.TERMINAL_RECIPIENT,
    effect: {},
  },
  /**
   * Meta's per-user marketing cap is a property of the *recipient's* day, not
   * of our content — retrying cannot help, and counting it as a failure would
   * trip the campaign circuit breaker on a non-problem (FR-CAM-9, AR-22).
   */
  {
    code: 131049,
    meaning: 'Per-user marketing frequency cap',
    class: ERROR_CLASS.TERMINAL_RECIPIENT,
    effect: { campaignSkip: true },
  },
  {
    code: 131051,
    meaning: 'Unsupported message type',
    class: ERROR_CLASS.TERMINAL_CONTENT,
    effect: {},
  },
  {
    code: 131053,
    meaning: 'Media upload or download error',
    class: ERROR_CLASS.RETRYABLE_BACKOFF,
    effect: {},
  },
  {
    code: 131056,
    meaning: '(Business, user) pair rate limit',
    class: ERROR_CLASS.RETRYABLE_BACKOFF,
    effect: { widenSpacing: true },
  },
  {
    code: 130429,
    meaning: 'Throughput or rate limit exceeded',
    class: ERROR_CLASS.RETRYABLE_BACKOFF,
    effect: {},
  },
  {
    code: 131000,
    meaning: 'Generic Meta internal error',
    class: ERROR_CLASS.RETRYABLE_BACKOFF,
    effect: {},
  },
  {
    code: 131008,
    meaning: 'Required parameter missing',
    class: ERROR_CLASS.TERMINAL_CONTENT,
    effect: { pauseCampaign: true },
  },
  {
    code: 131009,
    meaning: 'Parameter value invalid',
    class: ERROR_CLASS.TERMINAL_CONTENT,
    effect: { pauseCampaign: true },
  },
  {
    code: 132000,
    meaning: 'Template parameter count mismatch',
    class: ERROR_CLASS.TERMINAL_CONTENT,
    effect: { pauseCampaign: true, unpublishTemplate: true },
  },
  {
    code: 132001,
    meaning: 'Template does not exist or is not approved in this language',
    class: ERROR_CLASS.TERMINAL_CONTENT,
    effect: { pauseCampaign: true, unpublishTemplate: true },
  },
  {
    code: 132005,
    meaning: 'Hydrated template text too long',
    class: ERROR_CLASS.TERMINAL_CONTENT,
    effect: { pauseCampaign: true },
  },
  /**
   * 132007 means a parameter carried a newline, tab or 4+ spaces that
   * `sanitiseParameter` should have removed. It is a validation gap in our
   * code, not a Meta problem, so it alerts.
   */
  {
    code: 132007,
    meaning: 'Template format character policy violation',
    class: ERROR_CLASS.TERMINAL_CONTENT,
    effect: { alertAdmin: true },
  },
  {
    code: 132012,
    meaning: 'Template parameter format mismatch',
    class: ERROR_CLASS.TERMINAL_CONTENT,
    effect: { pauseCampaign: true },
  },
  {
    code: 131064,
    meaning: 'Messaging limit or template category misuse',
    class: ERROR_CLASS.TERMINAL_CONTENT,
    effect: { pauseCampaign: true, unpublishTemplate: true, alertAdmin: true },
  },
  {
    code: 131031,
    meaning: 'Account locked or policy violation',
    class: ERROR_CLASS.TERMINAL_UNKNOWN,
    effect: { accountError: true, alertAdmin: true },
  },
  {
    code: 368,
    meaning: 'Temporarily blocked for policy violations',
    class: ERROR_CLASS.TERMINAL_UNKNOWN,
    effect: { accountError: true, alertAdmin: true },
  },
  {
    code: 100,
    meaning: 'Invalid parameter or bad request',
    class: ERROR_CLASS.TERMINAL_CONTENT,
    effect: {},
  },
  /**
   * A retry with a dead token is noise, not resilience: every attempt fails
   * identically until a human rotates the credential (R-8).
   */
  {
    code: 190,
    meaning: 'Access token expired or invalid',
    class: ERROR_CLASS.RETRYABLE_AFTER_REFRESH,
    effect: { accountError: true, alertAdmin: true },
  },
  {
    code: 200,
    meaning: 'Permission error — missing scope',
    class: ERROR_CLASS.RETRYABLE_AFTER_REFRESH,
    effect: { accountError: true, alertAdmin: true },
  },
  {
    code: 10,
    meaning: 'Permission error — missing scope',
    class: ERROR_CLASS.RETRYABLE_AFTER_REFRESH,
    effect: { accountError: true, alertAdmin: true },
  },
  {
    code: 299,
    meaning: 'Permission error — missing scope',
    class: ERROR_CLASS.RETRYABLE_AFTER_REFRESH,
    effect: { accountError: true, alertAdmin: true },
  },
  {
    code: 80007,
    meaning: 'Graph API rate limit',
    class: ERROR_CLASS.RETRYABLE_BACKOFF,
    effect: {},
  },
  {
    code: 33,
    meaning: 'Object does not exist or no permission — usually a wrong phone_number_id',
    class: ERROR_CLASS.TERMINAL_UNKNOWN,
    effect: { accountError: true, alertAdmin: true },
  },
];

export const ERROR_CATALOG = new Map<number, ErrorCatalogEntry>(
  ENTRIES.map((entry) => [entry.code, entry]),
);

/**
 * Internal codes stored in `whatsappMessage.errorCode` alongside Meta's.
 * Distinguishable by being non-numeric (appendix B §3).
 */
export const INTERNAL_ERROR = {
  POLICY_WINDOW_CLOSED: 'POLICY_WINDOW_CLOSED',
  POLICY_OPTED_OUT: 'POLICY_OPTED_OUT',
  POLICY_TEMPLATE_UNAVAILABLE: 'POLICY_TEMPLATE_UNAVAILABLE',
  POLICY_ACCOUNT_ERROR: 'POLICY_ACCOUNT_ERROR',
  INTERNAL_TIMEOUT: 'INTERNAL_TIMEOUT',
  UNKNOWN_ACCEPTANCE: 'UNKNOWN_ACCEPTANCE',
  CANCELLED: 'CANCELLED',
  MEDIA_TOO_LARGE: 'MEDIA_TOO_LARGE',
  MEDIA_UNAVAILABLE: 'MEDIA_UNAVAILABLE',
  /**
   * The attachment could not be read out of **Twenty's** storage, so nothing
   * was ever offered to Meta.
   *
   * Separate from `MEDIA_UNAVAILABLE`, which says the opposite — that Meta no
   * longer holds a file it once did. Every outbound attachment failure was
   * reported under that code, so the sentence a rep read named the wrong
   * system and pointed the fix in the wrong direction (D-58). The two also
   * differ in what to do next: Meta losing a file is terminal, a workspace read
   * failing is worth trying again.
   */
  ATTACHMENT_UNREADABLE: 'ATTACHMENT_UNREADABLE',
  CONFIG_MISSING: 'CONFIG_MISSING',
} as const;
export type InternalErrorCode = (typeof INTERNAL_ERROR)[keyof typeof INTERNAL_ERROR];

export type MetaApiErrorInit = {
  code?: number;
  subcode?: number;
  title?: string;
  details?: string;
  httpStatus?: number;
  /** The full Meta body, kept for the unmapped-code triage path. */
  raw?: unknown;
  /**
   * Set when the request was fully written but the outcome is unknown. Never
   * retried: Meta may have accepted it, and a duplicate customer message is
   * worse than a false failure (appendix B §2).
   */
  ambiguous?: boolean;
};

export class MetaApiError extends Error {
  readonly code: number | null;
  readonly subcode: number | null;
  readonly title: string | null;
  readonly details: string | null;
  readonly httpStatus: number | null;
  readonly raw: unknown;
  readonly ambiguous: boolean;

  constructor(message: string, init: MetaApiErrorInit = {}) {
    super(message);
    this.name = 'MetaApiError';
    this.code = init.code ?? null;
    this.subcode = init.subcode ?? null;
    this.title = init.title ?? null;
    this.details = init.details ?? null;
    this.httpStatus = init.httpStatus ?? null;
    this.raw = init.raw;
    this.ambiguous = init.ambiguous === true;
  }

  get retryable(): boolean {
    return classify(this).class === ERROR_CLASS.RETRYABLE_BACKOFF;
  }
}

export type Classification = {
  class: ErrorClass;
  effect: ErrorEffect;
  code: number | null;
  meaning: string;
  /** True when the code is not in the catalogue — the signal that it needs a row. */
  unmapped: boolean;
};

const UNMAPPED = (code: number | null, meaning: string): Classification => ({
  class: ERROR_CLASS.TERMINAL_UNKNOWN,
  effect: {},
  code,
  meaning,
  unmapped: true,
});

/**
 * Classify by error code first, then by HTTP status. The code is the more
 * specific signal — a 400 carrying 131049 is a recipient outcome, not a bad
 * request — so a status-only rule must never shadow it.
 */
export const classify = (error: MetaApiError): Classification => {
  if (error.ambiguous) {
    return {
      class: ERROR_CLASS.TERMINAL_UNKNOWN,
      effect: {},
      code: error.code,
      meaning: 'Ambiguous send outcome — request written, response never read',
      unmapped: false,
    };
  }

  if (error.code !== null) {
    const entry = ERROR_CATALOG.get(error.code);

    if (entry !== undefined) {
      return {
        class: entry.class,
        effect: entry.effect,
        code: entry.code,
        meaning: entry.meaning,
        unmapped: false,
      };
    }
  }

  const status = error.httpStatus;

  if (status === 401 || status === 403) {
    return {
      class: ERROR_CLASS.RETRYABLE_AFTER_REFRESH,
      effect: { accountError: true, alertAdmin: true },
      code: error.code,
      meaning: `HTTP ${status} — credential rejected`,
      unmapped: false,
    };
  }

  if (status === 429) {
    return {
      class: ERROR_CLASS.RETRYABLE_BACKOFF,
      effect: {},
      code: error.code,
      meaning: 'HTTP 429 — rate limited',
      unmapped: false,
    };
  }

  if (status !== null && status >= 500) {
    return {
      class: ERROR_CLASS.RETRYABLE_BACKOFF,
      effect: {},
      code: error.code,
      meaning: `HTTP ${status} — Meta server error`,
      unmapped: false,
    };
  }

  if (status === 404) {
    return {
      class: ERROR_CLASS.TERMINAL_UNKNOWN,
      effect: { accountError: true, alertAdmin: true },
      code: error.code,
      meaning: 'HTTP 404 — unknown id',
      unmapped: false,
    };
  }

  return UNMAPPED(error.code, error.code === null ? 'Unclassified failure' : `Unmapped code ${error.code}`);
};

/** A network failure before the request completed is always safe to retry. */
export const networkError = (cause: unknown): MetaApiError =>
  new MetaApiError('Network error contacting Meta', {
    httpStatus: 503,
    raw: cause instanceof Error ? cause.message : cause,
  });

/**
 * A timeout after the request was fully written. Marked ambiguous, never
 * retried — the send may have succeeded and we cannot tell.
 */
export const ambiguousError = (cause: unknown): MetaApiError =>
  new MetaApiError('Send outcome unknown', {
    ambiguous: true,
    raw: cause instanceof Error ? cause.message : cause,
  });

/** Builds a MetaApiError from a Graph API error body. */
export const fromResponseBody = (httpStatus: number, body: unknown): MetaApiError => {
  const error = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const data = error.error_data as { details?: string } | undefined;

  const title = typeof error.error_user_title === 'string' ? error.error_user_title : undefined;
  const message = typeof error.message === 'string' ? error.message : `HTTP ${httpStatus}`;

  return new MetaApiError(message, {
    code: typeof error.code === 'number' ? error.code : undefined,
    subcode: typeof error.error_subcode === 'number' ? error.error_subcode : undefined,
    title: title ?? (typeof error.type === 'string' ? error.type : undefined),
    details:
      data?.details ??
      (typeof error.error_user_msg === 'string' ? error.error_user_msg : message),
    httpStatus,
    raw: body,
  });
};
