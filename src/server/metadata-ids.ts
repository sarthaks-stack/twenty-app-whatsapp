import { kv } from 'twenty-sdk/logic-function';

import { metadataClient } from './clients';
import { describeError, logger } from './logger';

/**
 * Metadata identifiers resolved at **runtime**.
 *
 * This module exists because of a platform constraint that fails silently:
 * the logic-function bundler replaces everything imported from
 * `twenty-sdk/define` with `__anyStub`. That module is a *build-time* surface —
 * it produces the manifest — so a derived value like
 * `getFieldUniversalIdentifier(...)` evaluates to nothing inside a running
 * function.
 *
 * Nothing warns about this. The constant is still a `string` to the type
 * checker, the bundle builds, the app applies, and the first real call fails
 * with a message about a missing GraphQL variable that names neither the
 * constant nor the cause. So identifiers a function needs at runtime are asked
 * of the server, and cached — they never change for an installed app.
 */

const cacheKey = (kind: string, key: string): string => `wa:metadata-id:${kind}:${key}`;

const memo = new Map<string, string>();

const cached = async (key: string, resolve: () => Promise<string | null>): Promise<string | null> => {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;

  const stored = await kv.get<string>(key, { scope: 'WORKSPACE' });

  if (typeof stored === 'string' && stored.length > 0) {
    memo.set(key, stored);

    return stored;
  }

  const resolved = await resolve();
  if (resolved === null) return null;

  memo.set(key, resolved);
  await kv.set(key, resolved, { scope: 'WORKSPACE' });

  return resolved;
};

/** The object's *metadata id* — what `timelineActivity.linkedObjectMetadataId` wants. */
export const resolveObjectMetadataId = async (
  objectUniversalIdentifier: string,
): Promise<string | null> =>
  cached(cacheKey('object', objectUniversalIdentifier), async () => {
    try {
      const result = await metadataClient().query({
        objects: {
          __args: { paging: { first: 500 }, filter: {} },
          edges: { node: { id: true, universalIdentifier: true } },
          pageInfo: { hasNextPage: true },
        },
      });

      const found = (result.objects.edges ?? [])
        .map((edge) => edge.node)
        .find((node) => node.universalIdentifier === objectUniversalIdentifier)?.id;

      if (found === undefined && result.objects.pageInfo?.hasNextPage === true) {
        logger.warn('metadata.lookup_truncated', { objectUniversalIdentifier });
      }

      return found ?? null;
    } catch (error) {
      logger.warn('metadata.object_lookup_failed', {
        objectUniversalIdentifier,
        ...describeError(error),
      });

      return null;
    }
  });

/**
 * A field's *universal identifier*, by object and field name — what
 * `uploadFile` wants.
 *
 * Looked up by name rather than derived, because the derivation is exactly the
 * build-time function the bundle stubs out. The server is the authority anyway:
 * it holds whatever identifier the last apply actually created.
 */
export const resolveFieldUniversalIdentifier = async (
  objectUniversalIdentifier: string,
  fieldName: string,
): Promise<string | null> =>
  cached(cacheKey('field', `${objectUniversalIdentifier}:${fieldName}`), async () => {
    try {
      const result = await metadataClient().query({
        objects: {
          __args: { paging: { first: 500 }, filter: {} },
          edges: {
            node: {
              universalIdentifier: true,
              fields: {
                __args: { paging: { first: 500 }, filter: {} },
                edges: { node: { name: true, universalIdentifier: true } },
                pageInfo: { hasNextPage: true },
              },
            },
          },
          pageInfo: { hasNextPage: true },
        },
      });

      const objects = (result.objects.edges ?? []).map((edge) => edge.node);
      const object = objects.find(
        (node) => node.universalIdentifier === objectUniversalIdentifier,
      );

      const found = (object?.fields?.edges ?? [])
        .map((edge) => edge.node)
        .find((node) => node.name === fieldName)?.universalIdentifier;

      /**
       * A miss on a page that was full is not the same answer as a miss on a
       * complete list — the first means "we did not look far enough" and used
       * to be indistinguishable from "it is not there" (D-37). It still
       * answers null, because a guess would be worse, but it says so.
       */
      if (found === undefined) {
        const truncated =
          (object === undefined && result.objects.pageInfo?.hasNextPage === true) ||
          object?.fields?.pageInfo?.hasNextPage === true;

        if (truncated) {
          logger.warn('metadata.lookup_truncated', {
            objectUniversalIdentifier,
            fieldName,
            objects: objects.length,
            fields: object?.fields?.edges?.length ?? 0,
          });
        }
      }

      return found ?? null;
    } catch (error) {
      logger.warn('metadata.field_lookup_failed', {
        objectUniversalIdentifier,
        fieldName,
        ...describeError(error),
      });

      return null;
    }
  });

/**
 * A field's *metadata id* — what `viewField.fieldMetadataId` joins on.
 *
 * Distinct from the universal identifier above: view-field rows reference the
 * per-workspace metadata id, not the app-scoped universal one.
 */
export const resolveFieldMetadataId = async (
  objectUniversalIdentifier: string,
  fieldName: string,
): Promise<string | null> =>
  cached(cacheKey('field-id', `${objectUniversalIdentifier}:${fieldName}`), async () => {
    try {
      const result = await metadataClient().query({
        objects: {
          __args: { paging: { first: 500 }, filter: {} },
          edges: {
            node: {
              universalIdentifier: true,
              fields: {
                __args: { paging: { first: 500 }, filter: {} },
                edges: { node: { id: true, name: true } },
                pageInfo: { hasNextPage: true },
              },
            },
          },
          pageInfo: { hasNextPage: true },
        },
      });

      const object = (result.objects.edges ?? [])
        .map((edge) => edge.node)
        .find((node) => node.universalIdentifier === objectUniversalIdentifier);

      return (
        (object?.fields?.edges ?? [])
          .map((edge) => edge.node)
          .find((node) => node.name === fieldName)?.id ?? null
      );
    } catch (error) {
      logger.warn('metadata.field_id_lookup_failed', {
        objectUniversalIdentifier,
        fieldName,
        ...describeError(error),
      });

      return null;
    }
  });

/** Test seam. */
export const resetMetadataIdCache = (): void => {
  memo.clear();
};
