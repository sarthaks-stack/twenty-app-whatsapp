import { INTERNAL_ERROR } from './errors';

/**
 * Server-variable access (SEC-1).
 *
 * `requireSecret` fails closed. There is no default, no `?? ''` and no
 * "development fallback" — a missing App Secret must stop the webhook resolver
 * dead, because the alternative is verifying every signature against an empty
 * key and accepting forged deliveries. The thrown error names the variable and
 * never its value.
 */

export class MissingConfigError extends Error {
  readonly code = INTERNAL_ERROR.CONFIG_MISSING;
  readonly variable: string;

  constructor(variable: string) {
    super(`Required server variable ${variable} is not set`);
    this.name = 'MissingConfigError';
    this.variable = variable;
  }
}

const read = (name: string): string | undefined => {
  const value = process.env[name];

  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
};

export const requireSecret = (name: string): string => {
  const value = read(name);
  if (value === undefined) throw new MissingConfigError(name);

  return value;
};

export const optionalSecret = (name: string): string | null => read(name) ?? null;

export const DEFAULT_GRAPH_VERSION = 'v26.0';

/**
 * Pinned by default (C-7): Meta deprecates versions on a schedule, and an app
 * that silently followed `latest` would change payload behaviour on Meta's
 * timetable rather than ours.
 */
export const graphVersion = (): string => read('META_GRAPH_VERSION') ?? DEFAULT_GRAPH_VERSION;

export const graphBaseUrl = (): string => `https://graph.facebook.com/${graphVersion()}`;

export type ProviderCredentials = {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
};

/** Read at call time, never cached: a rotated token must take effect immediately. */
export const providerCredentials = (): ProviderCredentials => ({
  accessToken: requireSecret('META_ACCESS_TOKEN'),
  appSecret: requireSecret('META_APP_SECRET'),
  verifyToken: requireSecret('META_VERIFY_TOKEN'),
});
