import { createCloudApiProvider } from './cloud-api.provider';
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

export * from './types';
export * from './errors';
export * from './payload';
export { verifyMetaSignature, verifyMetaVerifyToken, constantTimeEquals } from './verify-signature';
