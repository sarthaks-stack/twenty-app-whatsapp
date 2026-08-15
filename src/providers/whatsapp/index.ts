import { createCloudApiProvider } from './cloud-api.provider';
import { requireSecret } from './config';
import { verifyMetaSignature, verifyMetaVerifyToken } from './verify-signature';
import type { WhatsAppProvider } from './types';

/**
 * The provider factory (AR-18, D-14).
 *
 * One implementation exists today. The indirection earns its keep anyway: it is
 * the seam every test substitutes at, and it is the single place that would
 * change if a second WhatsApp BSP were ever added. `WA_PROVIDER` naming an
 * unknown value fails loudly rather than falling back to Meta — a silent
 * fallback would send real customer messages through a provider nobody
 * selected.
 */

const REGISTRY: Record<string, () => WhatsAppProvider> = {
  META_CLOUD_API: createCloudApiProvider,
};

export const DEFAULT_PROVIDER = 'META_CLOUD_API';

let cached: { key: string; provider: WhatsAppProvider } | null = null;

export const getProvider = (): WhatsAppProvider => {
  const key = (process.env.WA_PROVIDER ?? DEFAULT_PROVIDER).trim().toUpperCase();

  if (cached?.key === key) return cached.provider;

  const factory = REGISTRY[key];
  if (factory === undefined) {
    throw new Error(
      `Unknown WA_PROVIDER "${key}". Known providers: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }

  const provider = factory();
  cached = { key, provider };

  return provider;
};

/** Test seam: forces the next `getProvider()` to rebuild. */
export const resetProviderCache = (): void => {
  cached = null;
};

/**
 * Signature and token checks that read their own secret.
 *
 * `verify-signature.ts` stays dependency-free so the capture harness can import
 * it and pass a secret from `.dev.vars` — that is what makes a capture session
 * a live conformance test. These two wrappers exist so that no *handler* ever
 * names `META_APP_SECRET` or `META_VERIFY_TOKEN`: the secret enters the process
 * in one directory, which is the rule the architecture test enforces.
 */
export const verifyIncomingSignature = ({
  rawBody,
  header,
}: {
  rawBody: string | Buffer;
  header: string | undefined;
}): boolean =>
  verifyMetaSignature({ rawBody, header, appSecret: requireSecret('META_APP_SECRET') });

export const verifyIncomingToken = (provided: string | undefined): boolean =>
  verifyMetaVerifyToken(provided, requireSecret('META_VERIFY_TOKEN'));

export * from './types';
export * from './errors';
export * from './payload';
export {
  META_SIGNATURE_HEADER,
  verifyMetaSignature,
  verifyMetaVerifyToken,
  constantTimeEquals,
} from './verify-signature';
