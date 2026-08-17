import type { Quality, TemplateCategory, TemplateStatus } from '../../domain/constants';
import { nodesOf, pageOf, query, type JsonObject } from './base';

/**
 * `whatsappTemplate`.
 *
 * **Sync is authoritative.** Nothing in the CRM may edit `category`, `status`,
 * `components` or `qualityScore` — Meta owns them, including silent
 * re-categorisation. `publishedToCrm` is the only CRM-owned column, which is
 * why the patch type separates the two rather than exposing one bag of fields.
 */

const TEMPLATE_FIELDS = {
  id: true,
  metaTemplateId: true,
  name: true,
  language: true,
  category: true,
  previousCategory: true,
  status: true,
  rejectedReason: true,
  qualityScore: true,
  components: true,
  variableSpec: true,
  publishedToCrm: true,
  isUsableInCrm: true,
  unsupportedReason: true,
  lastSyncedAt: true,
  sentCount: true,
  deliveredCount: true,
  readCount: true,
  accountId: true,
} as const;

export type WhatsappTemplateRecord = {
  id: string;
  metaTemplateId?: string | null;
  name?: string | null;
  language?: string | null;
  category?: string | null;
  previousCategory?: string | null;
  status?: string | null;
  rejectedReason?: string | null;
  qualityScore?: string | null;
  components?: JsonObject | null;
  variableSpec?: JsonObject | null;
  publishedToCrm?: boolean | null;
  isUsableInCrm?: boolean | null;
  unsupportedReason?: string | null;
  lastSyncedAt?: string | null;
  sentCount?: number | null;
  deliveredCount?: number | null;
  readCount?: number | null;
  accountId?: string | null;
};

export const findTemplateByMetaId = async (
  accountId: string,
  metaTemplateId: string,
): Promise<WhatsappTemplateRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappTemplates: {
          __args: {
            filter: { accountId: { eq: accountId }, metaTemplateId: { eq: metaTemplateId } },
            first: 1,
          },
          edges: { node: TEMPLATE_FIELDS },
        },
      }),
    'templates.findByMetaId',
  );

  return nodesOf<WhatsappTemplateRecord>(result.whatsappTemplates)[0] ?? null;
};

export const findTemplateById = async (
  id: string,
): Promise<WhatsappTemplateRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappTemplates: {
          __args: { filter: { id: { eq: id } }, first: 1 },
          edges: { node: TEMPLATE_FIELDS },
        },
      }),
    'templates.findById',
  );

  return nodesOf<WhatsappTemplateRecord>(result.whatsappTemplates)[0] ?? null;
};

export const listTemplatesForAccount = async (
  accountId: string,
  limit = 60,
): Promise<WhatsappTemplateRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappTemplates: {
          __args: { filter: { accountId: { eq: accountId } }, first: limit },
          edges: { node: TEMPLATE_FIELDS },
        },
      }),
    'templates.listForAccount',
  );

  return nodesOf<WhatsappTemplateRecord>(result.whatsappTemplates);
};

export type SendableTemplatePageInput = {
  accountId: string;
  language?: string | null;
  category?: TemplateCategory | null;
  nameContains?: string | null;
  first?: number | null;
  after?: string | null;
};

export type SendableTemplatePage = {
  templates: WhatsappTemplateRecord[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export const MAX_SENDABLE_TEMPLATE_PAGE = 50;

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

/**
 * The catalogue an AI tool may show as sendable.
 *
 * The three state predicates live in the database query rather than after a
 * fixed-size read. Filtering a page in memory would make an eligible template
 * beyond that page invisible and make the cursor describe rows the caller
 * never saw (specs/17 §4.3).
 */
export const listSendableTemplatesPage = async ({
  accountId,
  language = null,
  category = null,
  nameContains = null,
  first = 20,
  after = null,
}: SendableTemplatePageInput): Promise<SendableTemplatePage> => {
  const pageSize = Math.min(
    MAX_SENDABLE_TEMPLATE_PAGE,
    Math.max(1, Math.trunc(typeof first === 'number' && Number.isFinite(first) ? first : 20)),
  );
  const wantedName = typeof nameContains === 'string' ? nameContains.trim() : '';

  const result = await query(
    (client) =>
      client.query({
        whatsappTemplates: {
          __args: {
            filter: {
              accountId: { eq: accountId },
              status: { eq: 'APPROVED' },
              publishedToCrm: { eq: true },
              isUsableInCrm: { eq: true },
              ...(typeof language === 'string' && language.length > 0
                ? { language: { eq: language } }
                : {}),
              ...(category === null ? {} : { category: { eq: category } }),
              ...(wantedName.length === 0
                ? {}
                : { name: { ilike: `%${escapeLike(wantedName)}%` } }),
            },
            orderBy: [
              { name: 'AscNullsLast' },
              { language: 'AscNullsLast' },
              { id: 'AscNullsFirst' },
            ],
            first: pageSize,
            ...(after === null || after.length === 0 ? {} : { after }),
          },
          edges: { node: TEMPLATE_FIELDS },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    'templates.listSendablePage',
  );

  const page = pageOf<WhatsappTemplateRecord>(result.whatsappTemplates);

  return {
    templates: page.items,
    pageInfo: {
      hasNextPage: result.whatsappTemplates?.pageInfo?.hasNextPage === true,
      endCursor: page.nextCursor,
    },
  };
};

/** Meta-owned columns. Written by sync and by webhook events, never by a user. */
export type TemplateSyncPatch = {
  name?: string;
  language?: string;
  category?: TemplateCategory;
  previousCategory?: TemplateCategory | null;
  status?: TemplateStatus;
  rejectedReason?: string | null;
  qualityScore?: Quality;
  components?: JsonObject | null;
  variableSpec?: JsonObject | null;
  isUsableInCrm?: boolean;
  unsupportedReason?: string | null;
  lastSyncedAt?: string;
  /**
   * Present here rather than in a separate patch because degradation must
   * un-publish in the *same* write that records it — a template that is
   * rejected but still published is a send that will fail for everyone
   * (specs/03 §6).
   */
  publishedToCrm?: boolean;
};

export const patchTemplate = async (id: string, data: TemplateSyncPatch): Promise<void> => {
  await query(
    (client) => client.mutation({ updateWhatsappTemplate: { __args: { id, data }, id: true } }),
    'templates.patch',
  );
};

export const createTemplateRecord = async (
  data: TemplateSyncPatch & { accountId: string; metaTemplateId: string; name: string; language: string },
): Promise<WhatsappTemplateRecord> => {
  const result = await query(
    (client) =>
      client.mutation({
        createWhatsappTemplate: { __args: { data }, ...TEMPLATE_FIELDS },
      }),
    'templates.create',
  );

  return result.createWhatsappTemplate as WhatsappTemplateRecord;
};
