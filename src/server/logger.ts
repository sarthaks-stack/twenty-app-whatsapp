/**
 * Structured logging (NFR-O1, SEC-1). The only module permitted to call
 * `console.*`.
 *
 * The concentration is the point. Every line goes through the redactor, so
 * there is no route by which an access token or a customer's message body
 * reaches a log aggregator — and deliberately **no "log the raw request" debug
 * switch**: the raw payload already lives in `whatsappWebhookEvent.payload`,
 * which is access-controlled, whereas logs are not.
 *
 * `correlationId` is what makes a complaint traceable. Given "she never got the
 * message", one WAMID grep reconstructs resolver → ingest → processor → sender
 * → status across five functions.
 */

export const LOG_LEVEL = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LOG_LEVEL;

const configuredLevel = (): number => {
  const raw = (process.env.WA_LOG_LEVEL ?? 'info').trim().toLowerCase();

  return LOG_LEVEL[raw as LogLevel] ?? LOG_LEVEL.info;
};

export const REDACTED = '«redacted»';

const SECRET_KEY_PATTERN =
  /(authorization|access[_-]?token|app[_-]?secret|verify[_-]?token|api[_-]?key|password|signature|bearer|hash)/i;

/**
 * A long base64/hex-shaped string is a token, a signature or a media hash. None
 * of the three belongs in a log line, and the shape catches the ones no key
 * name would — a token pasted into a free-text `detail`, for instance.
 */
const OPAQUE_VALUE = /^[A-Za-z0-9+/=_-]{100,}$/;

const secretValues = (): string[] =>
  [
    process.env.META_ACCESS_TOKEN,
    process.env.META_APP_SECRET,
    process.env.META_VERIFY_TOKEN,
  ].filter((value): value is string => typeof value === 'string' && value.length >= 8);

const MAX_DEPTH = 6;

export const redactForLog = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_DEPTH) return REDACTED;

  if (typeof value === 'string') {
    if (secretValues().some((secret) => value.includes(secret))) return REDACTED;

    return OPAQUE_VALUE.test(value) ? REDACTED : value;
  }

  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? REDACTED : redactForLog(item, depth + 1),
    ]),
  );
};

export type LogContext = {
  correlationId?: string | null;
  fn?: string;
  accountId?: string | null;
  threadId?: string | null;
  campaignId?: string | null;
  durationMs?: number;
  [key: string]: unknown;
};

export type Logger = {
  debug(event: string, context?: LogContext): void;
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
  /** A child carrying fixed context — the usual per-invocation pattern. */
  child(context: LogContext): Logger;
};

const emit = (level: LogLevel, event: string, context: LogContext): void => {
  if (LOG_LEVEL[level] < configuredLevel()) return;

  /**
   * Serialisation must not throw.
   *
   * `JSON.stringify` rejects a BigInt outright and dies on a circular
   * structure or a `toJSON` that throws — and the context most likely to
   * contain one is a described error, which means the failure would land
   * *inside a catch block* and replace the real error with a TypeError about
   * logging it (D-45). The line degrades instead: the event still gets out.
   */
  let line: string;

  try {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...(redactForLog(context) as Record<string, unknown>),
    });
  } catch {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      contextUnserialisable: true,
    });
  }

  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

const build = (base: LogContext): Logger => ({
  debug: (event, context) => emit('debug', event, { ...base, ...context }),
  info: (event, context) => emit('info', event, { ...base, ...context }),
  warn: (event, context) => emit('warn', event, { ...base, ...context }),
  error: (event, context) => emit('error', event, { ...base, ...context }),
  child: (context) => build({ ...base, ...context }),
});

export const logger: Logger = build({});

/** `logger.child({ fn })` for a logic function entry point. */
export const loggerFor = (fn: string, context: LogContext = {}): Logger =>
  logger.child({ fn, ...context });

/**
 * Normalises a thrown value for logging. `Error` instances lose everything but
 * `message` under `JSON.stringify`, which is how a stack trace goes missing
 * from exactly the log line that needed it.
 */
export const describeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(typeof error.stack === 'string'
        ? { errorStack: error.stack.split('\n').slice(0, 6).join('\n') }
        : {}),
      ...Object.fromEntries(
        Object.entries(error as unknown as Record<string, unknown>).filter(
          ([key]) => !['name', 'message', 'stack'].includes(key),
        ),
      ),
    };
  }

  return { errorMessage: String(error) };
};
