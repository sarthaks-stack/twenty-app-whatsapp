import { defineLogicFunction } from 'twenty-sdk/define';

import { LF_TEMPLATE_SYNC } from '../constants/universal-identifiers';
import {
  ACCOUNT_STATUS,
  QUALITY,
  TEMPLATE_CATEGORY,
  TEMPLATE_STATUS,
  type Quality,
  type TemplateCategory,
  type TemplateStatus,
} from '../domain/constants';
import {
  assessSupport,
  deriveVariableSpec,
  type MetaTemplateComponent,
} from '../domain/template-spec';
import { getProvider } from '../providers/whatsapp';
import { MetaApiError } from '../providers/whatsapp/errors';
import type { MetaTemplate } from '../providers/whatsapp/types';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import {
  findAccountById,
  listAccounts,
  type WhatsappAccountRecord,
} from '../server/repositories/accounts';
import { pageOf, query } from '../server/repositories/base';
import {
  createTemplateRecord,
  findTemplateByMetaId,
  patchTemplate,
  type TemplateSyncPatch,
} from '../server/repositories/templates';

/**
 * Templates, in both directions (FR-TPL-1, FR-TPL-6, specs/06 §1 and §6).
 *
 * **Sync is authoritative.** Nothing in the CRM may edit `category`, `status`,
 * `components` or `qualityScore` — Meta owns them, and it re-categorises
 * templates silently, without a webhook and without asking. `publishedToCrm` is
 * the single CRM-owned column, and it is only ever set by a human.
 *
 * **Absence is the only deletion signal.** Meta does not tell us when a
 * template is deleted; it simply stops appearing. So a full pass records what
 * it saw and disables everything it did not — which is why the loop must
 * complete before anything is disabled, and why a truncated page walk must
 * never be treated as a complete one.
 */

export type TemplateSyncPayload = {
  /** One account, or every eligible account when omitted. */
  accountId?: string;
  reason?: string;
};

export type AccountSyncResult = {
  accountId: string;
  created: number;
  updated: number;
  disappeared: number;
  pages: number;
  truncated: boolean;
  error?: string;
};

export type TemplateSyncResult = {
  accounts: AccountSyncResult[];
};

/**
 * 50 pages of 100 is 5 000 templates, comfortably above Meta's own portfolio
 * limits. The cap exists so a pagination bug cannot spin a cron forever; when
 * it is hit the pass is marked truncated and **nothing is disabled**, because a
 * partial listing is indistinguishable from mass deletion.
 */
export const MAX_PAGES = 50;

const STATUS_FROM_META: Record<string, TemplateStatus> = {
  APPROVED: TEMPLATE_STATUS.APPROVED,
  PENDING: TEMPLATE_STATUS.PENDING,
  IN_APPEAL: TEMPLATE_STATUS.IN_APPEAL,
  REJECTED: TEMPLATE_STATUS.REJECTED,
  PAUSED: TEMPLATE_STATUS.PAUSED,
  DISABLED: TEMPLATE_STATUS.DISABLED,
  PENDING_DELETION: TEMPLATE_STATUS.DISABLED,
  DELETED: TEMPLATE_STATUS.DISABLED,
};

const CATEGORY_FROM_META: Record<string, TemplateCategory> = {
  MARKETING: TEMPLATE_CATEGORY.MARKETING,
  UTILITY: TEMPLATE_CATEGORY.UTILITY,
  AUTHENTICATION: TEMPLATE_CATEGORY.AUTHENTICATION,
};

const QUALITY_FROM_META: Record<string, Quality> = {
  GREEN: QUALITY.GREEN,
  YELLOW: QUALITY.YELLOW,
  RED: QUALITY.RED,
  UNKNOWN: QUALITY.UNKNOWN,
};

export const templateStatusFor = (value: string | null | undefined): TemplateStatus =>
  STATUS_FROM_META[(value ?? '').toUpperCase()] ?? TEMPLATE_STATUS.PENDING;

export const templateCategoryFor = (
  value: string | null | undefined,
): TemplateCategory => CATEGORY_FROM_META[(value ?? '').toUpperCase()] ?? TEMPLATE_CATEGORY.UTILITY;

/**
 * Whether a synced state should un-publish (specs/03 §6, FR-TPL-2).
 *
 * Fails closed: anything that is not `APPROVED`, and any RED quality score,
 * withdraws the template from the picker. A rejected-but-published template is
 * a send that fails for every recipient, and re-publishing is always a
 * deliberate human act rather than something a later sync can undo.
 */
export const shouldUnpublish = (
  status: TemplateStatus,
  quality: Quality,
): boolean => status !== TEMPLATE_STATUS.APPROVED || quality === QUALITY.RED;

export type UpsertOutcome = 'created' | 'updated';

const upsertTemplate = async (
  account: WhatsappAccountRecord,
  meta: MetaTemplate,
): Promise<UpsertOutcome> => {
  const components = (meta.components ?? []) as MetaTemplateComponent[];

  const status = templateStatusFor(meta.status);
  const category = templateCategoryFor(meta.category);
  const quality = QUALITY_FROM_META[(meta.qualityScore ?? '').toUpperCase()] ?? QUALITY.UNKNOWN;
  const support = assessSupport(components);

  const patch: TemplateSyncPatch = {
    name: meta.name,
    language: meta.language,
    category,
    status,
    qualityScore: quality,
    components: { components } as Record<string, unknown>,
    variableSpec: deriveVariableSpec(components) as unknown as Record<string, unknown>,
    isUsableInCrm: support.isUsableInCrm,
    unsupportedReason: support.unsupportedReason,
    lastSyncedAt: new Date().toISOString(),
  };

  const existing = await findTemplateByMetaId(account.id, meta.id);

  if (existing === null) {
    await createTemplateRecord({
      ...patch,
      accountId: account.id,
      metaTemplateId: meta.id,
      name: meta.name,
      language: meta.language,
    });

    return 'created';
  }

  /**
   * A silent re-categorisation changes what the message costs and whether a
   * campaign may send it at all, so the previous value is kept and flagged
   * rather than overwritten without trace (FR-TPL-5).
   */
  if (existing.category !== null && existing.category !== undefined && existing.category !== category) {
    patch.previousCategory = existing.category as TemplateCategory;
    count(METRIC.TEMPLATE_RECATEGORISED);

    logger.warn('wa.template.recategorised', {
      templateId: existing.id,
      from: existing.category,
      to: category,
    });
  }

  if (existing.publishedToCrm === true && shouldUnpublish(status, quality)) {
    patch.publishedToCrm = false;
    count(METRIC.TEMPLATE_UNPUBLISHED_ON_DEGRADATION);
  }

  await patchTemplate(existing.id, patch);

  return 'updated';
};

type LocalTemplate = { id: string; metaTemplateId?: string | null; status?: string | null };

/** A WABA may hold thousands of templates; one page of 500 is not the set. */
const LOCAL_TEMPLATE_PAGE = 200;
const MAX_LOCAL_TEMPLATE_PAGES = 60;

/**
 * Templates the CRM knows about that Meta no longer lists.
 *
 * Read *after* the page walk completes, and applied only when it completed:
 * a truncated listing looks exactly like a WABA whose templates were all
 * deleted, and acting on that would withdraw a working template set from every
 * rep and every campaign.
 */
const disableDisappeared = async (
  accountId: string,
  seen: Set<string>,
): Promise<number> => {
  /**
   * Every local template is examined, not the first page of them.
   *
   * A single `first: 500` meant that past 500 templates a genuinely deleted one
   * was never noticed: it stayed `ACTIVE` and publishable locally, and the
   * campaign that chose it failed at Meta for every recipient. Meta allows
   * thousands per WABA, so the cap was reachable by an ordinary business
   * rather than an extreme one (D-49).
   */
  const local: LocalTemplate[] = [];
  let after: string | null = null;

  for (let page = 0; page < MAX_LOCAL_TEMPLATE_PAGES; page += 1) {
    const result = await query(
      (client) =>
        client.query({
          whatsappTemplates: {
            __args: {
              filter: { accountId: { eq: accountId } },
              orderBy: [{ id: 'AscNullsFirst' }],
              first: LOCAL_TEMPLATE_PAGE,
              ...(after === null ? {} : { after }),
            },
            edges: { node: { id: true, metaTemplateId: true, status: true } },
            pageInfo: { hasNextPage: true, endCursor: true },
          },
        }),
      'templates.listForDisappearance',
    );

    const { items, nextCursor } = pageOf<LocalTemplate>(result.whatsappTemplates);

    local.push(...items);

    if (nextCursor === null) break;

    after = nextCursor;

    /**
     * Reaching the page cap means the local set was not fully read — and
     * "not fully read" is indistinguishable from "not present" to the filter
     * below, which would disable working templates. So it stops instead.
     */
    if (page === MAX_LOCAL_TEMPLATE_PAGES - 1) {
      logger.warn('wa.template.disappearance_scan_truncated', {
        accountId,
        scanned: local.length,
      });

      return 0;
    }
  }

  const gone = local.filter(
    (template) =>
      typeof template.metaTemplateId === 'string' &&
      !seen.has(template.metaTemplateId) &&
      template.status !== TEMPLATE_STATUS.DISABLED,
  );

  for (const template of gone) {
    await patchTemplate(template.id, {
      status: TEMPLATE_STATUS.DISABLED,
      publishedToCrm: false,
      unsupportedReason: 'No longer present in the WhatsApp Business Account',
      lastSyncedAt: new Date().toISOString(),
    });
  }

  if (gone.length > 0) count(METRIC.TEMPLATE_DISAPPEARED, gone.length);

  return gone.length;
};

export const syncAccount = async (
  account: WhatsappAccountRecord,
): Promise<AccountSyncResult> => {
  const log = logger.child({ fn: 'wa-template-sync', correlationId: account.id });

  const result: AccountSyncResult = {
    accountId: account.id,
    created: 0,
    updated: 0,
    disappeared: 0,
    pages: 0,
    truncated: false,
  };

  if (typeof account.wabaId !== 'string' || account.wabaId.length === 0) {
    return { ...result, error: 'account has no WABA id' };
  }

  const seen = new Set<string>();
  let cursor: string | undefined;

  try {
    do {
      const page = await getProvider().listTemplates(account.wabaId, cursor);

      result.pages += 1;

      for (const template of page.templates) {
        seen.add(template.id);

        const outcome = await upsertTemplate(account, template);

        if (outcome === 'created') result.created += 1;
        else result.updated += 1;
      }

      cursor = page.nextCursor;

      if (result.pages >= MAX_PAGES && cursor !== undefined) {
        result.truncated = true;
        log.warn('wa.template.sync_truncated', { pages: result.pages });
        break;
      }
    } while (cursor !== undefined);
  } catch (error) {
    const detail =
      error instanceof MetaApiError
        ? `${error.code ?? error.httpStatus ?? 'error'}: ${error.details ?? error.message}`
        : String(error);

    log.error('wa.template.sync_failed', { ...describeError(error) });

    return { ...result, truncated: true, error: detail };
  }

  if (!result.truncated) {
    result.disappeared = await disableDisappeared(account.id, seen);
  }

  count(METRIC.TEMPLATE_SYNCED, result.created + result.updated);
  log.info('wa.template.synced', result);

  return result;
};

export const syncTemplates = async (
  payload: TemplateSyncPayload = {},
): Promise<TemplateSyncResult> => {
  const accounts =
    typeof payload.accountId === 'string'
      ? [await findAccountById(payload.accountId)].filter(
          (account): account is WhatsappAccountRecord => account !== null,
        )
      : /**
         * `ERROR` accounts are included on purpose: a token fixed an hour ago
         * needs a sync to notice, and a sync that skipped them would leave the
         * template list stale until someone thought to press a button.
         */
        await listAccounts([ACCOUNT_STATUS.CONNECTED, ACCOUNT_STATUS.ERROR]);

  const results: AccountSyncResult[] = [];

  for (const account of accounts) {
    results.push(await syncAccount(account));
  }

  return { accounts: results };
};

export const handler = async (
  payload: TemplateSyncPayload = {},
): Promise<TemplateSyncResult> => syncTemplates(payload);

export default defineLogicFunction({
  universalIdentifier: LF_TEMPLATE_SYNC,
  name: 'wa-template-sync',
  description:
    'Pulls the template catalogue from Meta, derives variable specs, and disables templates that disappeared.',
  timeoutSeconds: 120,
  cronTriggerSettings: { pattern: '0 */6 * * *' },
  handler,
});
