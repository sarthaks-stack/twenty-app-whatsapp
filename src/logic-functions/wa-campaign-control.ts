import { defineLogicFunction } from 'twenty-sdk/define';
import { Response, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  LF_CAMPAIGN_SNAPSHOT,
  LF_CAMPAIGN_CONTROL,
  PERSON_OBJECT_UID,
} from '../constants/universal-identifiers';
import {
  describeAudience,
  parseAudienceDefinition,
} from '../domain/campaign/audience';
import { emptyBreakdown } from '../domain/campaign/exclusions';
import { estimateCampaignCostUsd, rateFor } from '../domain/campaign/guardrails';
import { projectDailySpread } from '../domain/campaign/tier-budget';
import { STATUS_REASON, canTransition } from '../domain/campaign/transitions';
import {
  ALLOWED_BINDING_PATHS,
  resolveParameters,
  type VariableMapping,
} from '../domain/campaign/variable-resolution';
import {
  CAMPAIGN_STATUS,
  LANE,
  QUALITY,
  RECIPIENT_STATUS,
  SOURCE_KIND,
  TEMPLATE_CATEGORY,
  TEMPLATE_STATUS,
  type CampaignStatus,
  type ExclusionReason,
  type TemplateCategory,
} from '../domain/constants';
import { toE164, toWaId } from '../domain/phone/normalise';
import { renderTemplate, type ResolvedParameters } from '../domain/template-render';
import type { VariableSpec } from '../domain/template-spec';
import { AudienceError, readAudiencePage, resolveViewFilter } from '../server/audience';
import { AUDIT_ACTION, audit } from '../server/audit';
import { authErrorResponse, requireCaller, requireRole, type Caller } from '../server/auth';
import { transitionCampaign } from '../server/campaign-state';
import { config, forAccount } from '../server/config';
import { enqueue } from '../server/jobs';
import { describeError, logger } from '../server/logger';
import { queueOutbound } from '../server/outbound';
import { findAccountById, type WhatsappAccountRecord } from '../server/repositories/accounts';
import { asJson } from '../server/repositories/base';
import {
  countRecipients,
  listRecipients,
  patchRecipients,
  retirePreviousSnapshot,
} from '../server/repositories/campaign-recipients';
import {
  createCampaign,
  findCampaignById,
  patchCampaign,
  type WhatsappCampaignRecord,
} from '../server/repositories/campaigns';
import { findTemplateById, type WhatsappTemplateRecord } from '../server/repositories/templates';
import { resolveObjectMetadataId } from '../server/metadata-ids';
import { listPersonViews } from '../server/repositories/views';
import { budgetForAccount, tierFor } from '../server/tier-ledger';
import { upsertThread } from '../server/threads';
import { EMPTY_VARIABLE_SPEC } from './wa-outbound-sender';

/**
 * Everything a human does to a campaign (FR-CAM-8, SEC-12, specs/07 §9).
 *
 * One route, because the actions are not independent: `build` must validate the
 * same audience `preview` renders, `launch` must re-run the gate `preflight`
 * showed, and every one of them writes the same audit line. Split across four
 * routes they would drift, and the one that drifted would be `launch`.
 *
 * **Admin-only for anything that writes or sends.** Object permissions protect
 * the Core API; they do not protect this route, which runs as the app. Reads
 * (`preview`, `preflight`) are agent-level because a rep looking at what a
 * campaign will say is not a privileged act — sending it is.
 */

export type CampaignAction =
  | 'audienceOptions'
  | 'create'
  | 'update'
  | 'build'
  | 'preview'
  | 'preflight'
  | 'testSend'
  | 'launch'
  | 'pause'
  | 'resume'
  | 'cancel';

export type CampaignControlBody = {
  action?: CampaignAction;
  campaignId?: string;
  name?: string;
  accountId?: string;
  templateId?: string;
  audienceDefinition?: unknown;
  variableMapping?: unknown;
  scheduledAt?: string | null;
  testRecipientPhones?: string[];
  maxFailureRatePct?: number;
  /** `launch`: the admin's acknowledgement of a YELLOW quality rating. */
  acknowledgeQuality?: boolean;
  /** `preview`: how many sample recipients to render. */
  sampleSize?: number;
};

/** Five is what the builder shows (specs/07 §2 step 4); ten is the ceiling. */
export const MAX_PREVIEW_SAMPLE = 10;

/** A test send is a handful of internal numbers, not a second audience. */
export const MAX_TEST_RECIPIENTS = 10;

type Loaded = {
  campaign: WhatsappCampaignRecord;
  account: WhatsappAccountRecord | null;
  template: WhatsappTemplateRecord | null;
};

const load = async (campaignId: string): Promise<Loaded | null> => {
  const campaign = await findCampaignById(campaignId);

  if (campaign === null) return null;

  const [account, template] = await Promise.all([
    typeof campaign.accountId === 'string' ? findAccountById(campaign.accountId) : null,
    typeof campaign.templateId === 'string' ? findTemplateById(campaign.templateId) : null,
  ]);

  return { campaign, account, template };
};

/**
 * Whether a template may carry a campaign at all (FR-CAM-1).
 *
 * `AUTHENTICATION` is excluded outright rather than warned about: an OTP
 * template has no bulk use case, and sending one to an audience is either a
 * mistake or an attempt to use a cheaper category for marketing — which is what
 * gets a number restricted.
 */
export const templateRefusal = (
  template: WhatsappTemplateRecord | null,
): string | null => {
  if (template === null) return 'The campaign has no template';
  if (template.status !== TEMPLATE_STATUS.APPROVED) {
    return `The template is ${template.status ?? 'unknown'}, not approved`;
  }
  if (template.publishedToCrm !== true) {
    return 'The template has not been published for use in the CRM';
  }
  if (template.isUsableInCrm !== true) {
    return template.unsupportedReason ?? 'The template is not usable from the CRM';
  }
  if (template.category === TEMPLATE_CATEGORY.AUTHENTICATION) {
    return 'Authentication templates cannot be sent as a campaign';
  }

  return null;
};

/**
 * The fields a snapshot is built *from* (specs/07 §3).
 *
 * Editing any of them makes an existing build a description of something that
 * no longer exists — most sharply the template, whose placeholders the frozen
 * parameters were resolved against.
 */
export const SNAPSHOT_DEFINING_FIELDS = [
  'templateId',
  'accountId',
  'audienceDefinition',
  'variableMapping',
] as const;

/**
 * Which snapshot-defining fields this edit touches, if the campaign is built.
 *
 * Empty means the edit is safe to apply in place: a `draft` has no snapshot to
 * invalidate, and renaming a campaign or moving its `scheduledAt` changes
 * nothing the audience was derived from.
 *
 * Non-empty means the campaign goes back to `draft` and must be rebuilt before
 * it can launch. It used to be applied silently, which left a `ready` campaign
 * holding parameters resolved against the template it *used* to have — so a
 * launch would fill the new template's placeholders with the old one's values,
 * with every field involved present and superficially valid (D-28).
 */
export const snapshotInvalidatedBy = (
  body: Record<string, unknown>,
  status: CampaignStatus,
): string[] =>
  status !== CAMPAIGN_STATUS.READY
    ? []
    : SNAPSHOT_DEFINING_FIELDS.filter((field) => body[field] !== undefined);

export type LaunchGate =
  | { allowed: true; warning: string | null }
  | { allowed: false; reason: string };

/**
 * The quality gate (FR-CAM-6).
 *
 * RED blocks: Meta has already told us this number is in trouble, and a bulk
 * send is the fastest way to lose it. YELLOW warns and requires the admin to
 * say so explicitly, because the judgement — is this campaign worth the risk to
 * the number? — is a business one and not ours to make silently.
 */
export const launchGate = (
  account: WhatsappAccountRecord | null,
  acknowledged: boolean,
): LaunchGate => {
  if (account === null) return { allowed: false, reason: 'The campaign has no sending number' };

  if (account.qualityRating === QUALITY.RED) {
    return {
      allowed: false,
      reason:
        'Meta has rated this number RED. Resolve the quality issue in Business Support Home before sending a campaign.',
    };
  }

  if (account.qualityRating === QUALITY.YELLOW) {
    return acknowledged
      ? { allowed: true, warning: 'Sent with a YELLOW quality rating, acknowledged by the admin' }
      : {
          allowed: false,
          reason:
            'This number has a YELLOW quality rating. Confirm with acknowledgeQuality to send anyway.',
        };
  }

  return { allowed: true, warning: null };
};

const specOf = (template: WhatsappTemplateRecord | null): VariableSpec =>
  template === null
    ? EMPTY_VARIABLE_SPEC
    : asJson<VariableSpec>(template.variableSpec, EMPTY_VARIABLE_SPEC);

export type PreviewRow = {
  personId: string | null;
  phone: string | null;
  ok: boolean;
  missing: string[];
  rendered: ReturnType<typeof renderTemplate>;
};

/**
 * The first few recipients, fully rendered (FR-CAM-4).
 *
 * Reads the snapshot when one exists and the audience when it does not, which
 * is the difference between "what this campaign *will* say" during the build
 * and "what it *does* say" once it is ready. The second is the one that
 * matters, because a preview computed from live data after the snapshot froze
 * would show text the recipients are not going to receive.
 */
export const previewCampaign = async ({
  campaign,
  account,
  template,
  sampleSize,
}: Loaded & { sampleSize: number }): Promise<PreviewRow[]> => {
  const spec = specOf(template);
  const snapshotted = await listRecipients({
    campaignId: campaign.id,
    statuses: [RECIPIENT_STATUS.PENDING],
    limit: sampleSize,
  });

  if (snapshotted.length > 0) {
    return snapshotted.map((recipient) => {
      const parameters = asJson<ResolvedParameters>(recipient.resolvedParameters, {
        body: [],
        buttons: [],
      });

      return {
        personId: recipient.personId ?? null,
        phone: recipient.resolvedPhone ?? null,
        ok: true,
        missing: [],
        rendered: renderTemplate(spec, parameters),
      };
    });
  }

  const parsed = parseAudienceDefinition(campaign.audienceDefinition);

  if (!parsed.ok) return [];

  const page = await readAudiencePage({ definition: parsed.definition, cursor: null });
  const mapping = asJson<VariableMapping>(campaign.variableMapping, {});
  const defaultCallingCode = forAccount(
    account?.defaultCountryCallingCode,
    config.defaultCountryCallingCode,
  );

  return page.people.slice(0, sampleSize).map((person) => {
    const resolution = resolveParameters({
      spec,
      mapping,
      subject: {
        person,
        account: {
          displayName: account?.displayName ?? account?.name ?? null,
          defaultCountryCallingCode: defaultCallingCode,
        },
        now: new Date(),
      },
    });

    return {
      personId: person.id,
      phone: toE164(
        `${person.phones?.primaryPhoneCallingCode ?? ''}${person.phones?.primaryPhoneNumber ?? ''}`,
        defaultCallingCode,
      ),
      ok: resolution.ok,
      missing: resolution.ok ? [] : resolution.missingKeys,
      rendered: renderTemplate(spec, resolution.parameters),
    };
  });
};

const preflight = async ({ campaign, account, template }: Loaded) => {
  const category = (template?.category ?? TEMPLATE_CATEGORY.UTILITY) as TemplateCategory;
  const breakdown = asJson<Record<string, number>>(
    campaign.exclusionBreakdown,
    emptyBreakdown(),
  );

  const recipientCount = campaign.recipientCount ?? 0;
  const budget = account === null ? null : budgetForAccount(account);

  const samples = await Promise.all(
    Object.keys(breakdown)
      .filter((reason) => (breakdown[reason] ?? 0) > 0)
      .map(async (reason) => [
        reason,
        (
          await listRecipients({
            campaignId: campaign.id,
            exclusionReason: reason as ExclusionReason,
            limit: 10,
          })
        ).map((recipient) => ({
          personId: recipient.personId ?? null,
          phone: recipient.resolvedPhone ?? null,
        })),
      ] as const),
  );

  return {
    recipients: {
      total: recipientCount,
      excluded: campaign.excludedCount ?? 0,
      breakdown,
      samples: Object.fromEntries(samples),
    },
    cost: {
      estimatedUsd: estimateCampaignCostUsd({
        recipientCount,
        category,
        rates: config.rates(),
      }),
      ratePerMessageUsd: rateFor(category, config.rates()),
      note: 'Estimated. Meta bills on delivery, so the actual will land slightly lower.',
    },
    tier:
      budget === null
        ? null
        : {
            tier: tierFor(account!),
            ...budget,
            /**
             * The spread is what turns "your audience is bigger than your daily
             * allowance" from a surprise two days in into a number on the
             * screen before launch (R-10).
             */
            spread: projectDailySpread({
              recipientCount,
              availablePerDay: budget.available,
            }),
          },
    quality: {
      rating: account?.qualityRating ?? QUALITY.UNKNOWN,
      gate: launchGate(account, false),
    },
    template:
      template === null
        ? null
        : {
            id: template.id,
            name: template.name ?? null,
            language: template.language ?? null,
            category: template.category ?? null,
            refusal: templateRefusal(template),
          },
    preview: await previewCampaign({ campaign, account, template, sampleSize: 1 }),
  };
};

/**
 * A test send (FR-CAM-12).
 *
 * On the **interactive** lane, deliberately. A test is a rep waiting for a
 * message on their own phone; putting it behind a campaign lane that may
 * already be pacing several thousand sends would make "did the test arrive?"
 * unanswerable for an hour.
 */
const testSend = async ({
  campaign,
  account,
  template,
  caller,
}: Loaded & { caller: Caller }): Promise<{ sent: number; skipped: string[] }> => {
  const phones = (campaign.testRecipientPhones ?? []).slice(0, MAX_TEST_RECIPIENTS);
  const defaultCallingCode = forAccount(
    account?.defaultCountryCallingCode,
    config.defaultCountryCallingCode,
  );

  const spec = specOf(template);
  const mapping = asJson<VariableMapping>(campaign.variableMapping, {});

  /**
   * The test uses the *first real recipient's* resolved values when a snapshot
   * exists, because a test rendered from placeholder text proves the template
   * is approved and nothing about whether the bindings are right — which is the
   * only thing a test send is for.
   */
  const [sample] = await listRecipients({
    campaignId: campaign.id,
    statuses: [RECIPIENT_STATUS.PENDING],
    limit: 1,
  });

  const parameters =
    sample === undefined
      ? resolveParameters({
          spec,
          mapping,
          subject: {
            person: null,
            account: {
              displayName: account?.displayName ?? account?.name ?? null,
              defaultCountryCallingCode: defaultCallingCode,
            },
            now: new Date(),
          },
        }).parameters
      : asJson<ResolvedParameters>(sample.resolvedParameters, { body: [], buttons: [] });

  const skipped: string[] = [];
  let sent = 0;

  for (const raw of phones) {
    const e164 = toE164(raw, defaultCallingCode);

    if (e164 === null) {
      skipped.push(`${raw}: not a valid number`);
      continue;
    }

    const { thread } = await upsertThread({ account: account!, waId: toWaId(e164) });

    await queueOutbound({
      thread,
      account: account!,
      spec: { kind: 'template', templateId: template!.id },
      body: template!.name ?? null,
      lane: LANE.INTERACTIVE,
      sourceKind: SOURCE_KIND.AGENT,
      sentById: caller.workspaceMemberId,
      template: {
        id: template!.id,
        name: template!.name ?? null,
        language: template!.language ?? null,
        category: template!.category ?? null,
        parameters,
      },
    });

    sent += 1;
  }

  return { sent, skipped };
};

export const handler = async (
  event: RoutePayload<CampaignControlBody>,
): Promise<Response> => {
  const log = logger.child({ fn: 'wa-campaign-control' });

  try {
    const caller = await requireCaller(event);

    const body = event.body ?? {};
    const action = body.action ?? 'preflight';

    /**
     * Every action but `create` names a campaign, so the lookup and its 404 are
     * done once. A route that repeated them per branch is a route where one
     * branch eventually answers 500 for a deleted campaign.
     */
    /**
     * `audienceOptions` names no campaign — it is what the builder asks
     * *before* there is one, so the audience step can offer real views instead
     * of a UUID box.
     */
    if (action === 'audienceOptions') {
      requireRole(caller, 'agent');

      const personObjectMetadataId = await resolveObjectMetadataId(PERSON_OBJECT_UID);

      return new Response(
        {
          views:
            personObjectMetadataId === null
              ? []
              : await listPersonViews(personObjectMetadataId),
          bindingPaths: ALLOWED_BINDING_PATHS,
        },
        { status: 200 },
      );
    }

    const loaded =
      action === 'create'
        ? null
        : typeof body.campaignId === 'string' && body.campaignId.length > 0
          ? await load(body.campaignId)
          : undefined;

    if (loaded === undefined) {
      return new Response({ error: 'campaignId is required' }, { status: 400 });
    }

    if (action !== 'create' && loaded === null) {
      return new Response({ error: 'Unknown campaign' }, { status: 404 });
    }

    switch (action) {
      case 'create': {
        requireRole(caller, 'admin');

        const name = (body.name ?? '').trim();

        if (name.length === 0) {
          return new Response({ error: 'name is required' }, { status: 400 });
        }

        if (typeof body.accountId !== 'string' || typeof body.templateId !== 'string') {
          return new Response(
            { error: 'accountId and templateId are required' },
            { status: 400 },
          );
        }

        const template = await findTemplateById(body.templateId);
        const refusal = templateRefusal(template);

        if (refusal !== null) {
          return new Response({ error: refusal }, { status: 400 });
        }

        const audience =
          body.audienceDefinition === undefined
            ? null
            : parseAudienceDefinition(body.audienceDefinition);

        if (audience !== null && !audience.ok) {
          return new Response({ error: audience.error }, { status: 400 });
        }

        const campaign = await createCampaign({
          name,
          status: CAMPAIGN_STATUS.DRAFT,
          accountId: body.accountId,
          templateId: body.templateId,
          ownerId: caller.workspaceMemberId,
          ...(audience === null
            ? {}
            : { audienceDefinition: audience.definition as unknown as Record<string, unknown> }),
          ...(body.variableMapping === undefined
            ? {}
            : { variableMapping: body.variableMapping as Record<string, unknown> }),
          ...(body.scheduledAt === undefined ? {} : { scheduledAt: body.scheduledAt }),
          ...(body.maxFailureRatePct === undefined
            ? {}
            : { maxFailureRatePct: body.maxFailureRatePct }),
          ...(body.testRecipientPhones === undefined
            ? {}
            : { testRecipientPhones: body.testRecipientPhones.slice(0, MAX_TEST_RECIPIENTS) }),
        });

        audit({
          action: AUDIT_ACTION.CAMPAIGN_CREATE,
          actorId: caller.workspaceMemberId,
          subject: { campaignId: campaign.id, templateId: body.templateId, accountId: body.accountId },
          details: { name },
        });

        return new Response({ campaign }, { status: 201 });
      }

      /**
       * Editing is confined to the states where nothing has been sent. Once a
       * campaign is scheduled its content is what the pre-flight showed and
       * what the admin confirmed, and quietly changing it afterwards would make
       * the audit record describe a campaign that never ran.
       */
      case 'update': {
        requireRole(caller, 'admin');

        const { campaign } = loaded!;
        const editable: string[] = [CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.READY];

        if (!editable.includes(campaign.status ?? '')) {
          return new Response(
            { error: `A ${campaign.status ?? 'unknown'} campaign cannot be edited` },
            { status: 409 },
          );
        }

        const audience =
          body.audienceDefinition === undefined
            ? null
            : parseAudienceDefinition(body.audienceDefinition);

        if (audience !== null && !audience.ok) {
          return new Response({ error: audience.error }, { status: 400 });
        }

        if (typeof body.templateId === 'string') {
          const refusal = templateRefusal(await findTemplateById(body.templateId));

          if (refusal !== null) return new Response({ error: refusal }, { status: 400 });
        }

        const invalidated = snapshotInvalidatedBy(
          body,
          (campaign.status ?? CAMPAIGN_STATUS.DRAFT) as CampaignStatus,
        );

        if (invalidated.length > 0) {
          const reopened = await transitionCampaign({
            campaign,
            to: CAMPAIGN_STATUS.DRAFT,
            reason: 'edited_after_build',
            actorId: caller.workspaceMemberId,
            details: { changed: invalidated },
          });

          if (!reopened.ok) return new Response({ error: reopened.reason }, { status: 409 });
        }

        await patchCampaign(campaign.id, {
          ...(body.name === undefined ? {} : { name: body.name.trim() }),
          ...(body.templateId === undefined ? {} : { templateId: body.templateId }),
          ...(body.accountId === undefined ? {} : { accountId: body.accountId }),
          ...(audience === null
            ? {}
            : { audienceDefinition: audience.definition as unknown as Record<string, unknown> }),
          ...(body.variableMapping === undefined
            ? {}
            : { variableMapping: body.variableMapping as Record<string, unknown> }),
          ...(body.scheduledAt === undefined ? {} : { scheduledAt: body.scheduledAt }),
          ...(body.maxFailureRatePct === undefined
            ? {}
            : { maxFailureRatePct: body.maxFailureRatePct }),
          ...(body.testRecipientPhones === undefined
            ? {}
            : { testRecipientPhones: body.testRecipientPhones.slice(0, MAX_TEST_RECIPIENTS) }),
        });

        return new Response({ campaign: await findCampaignById(campaign.id) }, { status: 200 });
      }

      case 'build': {
        requireRole(caller, 'admin');

        const { campaign, template } = loaded!;

        /**
         * The terminal check comes first, ahead of validating the template and
         * the audience. Both of those are expensive and — for a cancelled
         * campaign — beside the point: answering "this view uses a filter we
         * cannot reproduce" to someone who cancelled the campaign last week
         * sends them to fix something that does not matter.
         */
        const reachable = canTransition(
          (campaign.status ?? CAMPAIGN_STATUS.DRAFT) as CampaignStatus,
          CAMPAIGN_STATUS.SNAPSHOTTING,
        );

        if (!reachable.ok) return new Response({ error: reachable.reason }, { status: 409 });

        const refusal = templateRefusal(template);

        if (refusal !== null) return new Response({ error: refusal }, { status: 400 });

        const parsed = parseAudienceDefinition(campaign.audienceDefinition);

        if (!parsed.ok) return new Response({ error: parsed.error }, { status: 400 });

        /**
         * A view is resolved *here*, before the campaign leaves `draft`. The
         * translation can refuse — a filter we cannot reproduce exactly — and
         * discovering that inside a queued snapshot would leave the admin
         * staring at a campaign stuck in "building audience" with the reason
         * three log lines deep.
         */
        if (parsed.definition.kind === 'view') {
          try {
            await resolveViewFilter(parsed.definition.viewId);
          } catch (error) {
            if (error instanceof AudienceError) {
              return new Response(
                { error: error.message, reasons: error.reasons },
                { status: 400 },
              );
            }

            throw error;
          }
        }

        const moved = await transitionCampaign({
          campaign,
          to: CAMPAIGN_STATUS.SNAPSHOTTING,
          reason: 'building',
          actorId: caller.workspaceMemberId,
          patch: {
            recipientCount: 0,
            excludedCount: 0,
            exclusionBreakdown: { ...emptyBreakdown() },
          },
          details: { audience: describeAudience(parsed.definition) },
        });

        if (!moved.ok) return new Response({ error: moved.reason }, { status: 409 });

        /**
         * Anything the previous build wrote is retired before this one starts.
         *
         * Rebuilding is ordinary — fix a mapping, swap the template, widen the
         * view — and without this the old rows stayed. Their numbers still
         * counted as taken, so the second build excluded every single person as
         * a `duplicate` of their own row from the first, and the campaign
         * reported an audience of nobody with a reason that made no sense
         * (D-27).
         */
        const retired = await retirePreviousSnapshot(campaign.id);

        if (retired > 0) log.info('wa.campaign.snapshot_retired', { retired });

        const landed = await enqueue({
          logicFunctionUniversalIdentifier: LF_CAMPAIGN_SNAPSHOT,
          payload: { campaignId: campaign.id },
          correlationId: campaign.id,
        });

        if (!landed) {
          await transitionCampaign({
            campaign: { ...campaign, status: CAMPAIGN_STATUS.SNAPSHOTTING },
            to: CAMPAIGN_STATUS.FAILED,
            reason: STATUS_REASON.SNAPSHOT_FAILED,
          });

          return new Response(
            { error: 'Could not schedule the audience build' },
            { status: 503 },
          );
        }

        return new Response(
          { campaignId: campaign.id, status: CAMPAIGN_STATUS.SNAPSHOTTING },
          { status: 202 },
        );
      }

      case 'preview': {
        requireRole(caller, 'agent');

        const sampleSize = Math.min(
          MAX_PREVIEW_SAMPLE,
          Math.max(1, body.sampleSize ?? 5),
        );

        return new Response(
          { rows: await previewCampaign({ ...loaded!, sampleSize }) },
          { status: 200 },
        );
      }

      case 'preflight': {
        requireRole(caller, 'agent');

        return new Response(await preflight(loaded!), { status: 200 });
      }

      case 'testSend': {
        requireRole(caller, 'admin');

        const { campaign, account, template } = loaded!;
        const refusal = templateRefusal(template);

        if (refusal !== null) return new Response({ error: refusal }, { status: 400 });
        if (account === null) {
          return new Response({ error: 'The campaign has no sending number' }, { status: 400 });
        }

        if ((campaign.testRecipientPhones ?? []).length === 0) {
          return new Response(
            { error: 'Add at least one test recipient to the campaign first' },
            { status: 400 },
          );
        }

        const result = await testSend({ ...loaded!, caller });

        audit({
          action: AUDIT_ACTION.TEMPLATE_SEND,
          actorId: caller.workspaceMemberId,
          subject: { campaignId: campaign.id, templateId: template!.id },
          details: { testSend: true, ...result },
        });

        return new Response(result, { status: 200 });
      }

      case 'launch': {
        requireRole(caller, 'admin');

        const { campaign, account, template } = loaded!;
        const refusal = templateRefusal(template);

        if (refusal !== null) return new Response({ error: refusal }, { status: 400 });

        const gate = launchGate(account, body.acknowledgeQuality === true);

        if (!gate.allowed) return new Response({ error: gate.reason }, { status: 409 });

        if ((campaign.recipientCount ?? 0) === 0) {
          return new Response(
            { error: 'This campaign has no recipients — build the audience first' },
            { status: 409 },
          );
        }

        const scheduledAt =
          body.scheduledAt === undefined ? (campaign.scheduledAt ?? null) : body.scheduledAt;

        const future =
          typeof scheduledAt === 'string' && new Date(scheduledAt).getTime() > Date.now();

        const moved = await transitionCampaign({
          campaign,
          to: future ? CAMPAIGN_STATUS.SCHEDULED : CAMPAIGN_STATUS.RUNNING,
          reason: null,
          actorId: caller.workspaceMemberId,
          patch: {
            ...(scheduledAt === null ? {} : { scheduledAt }),
            ...(future ? {} : { startedAt: new Date().toISOString() }),
          },
          /**
           * The launch audit carries the whole basis of the send — audience,
           * counts, exclusions, template — so "who sent 5 000 messages, to
           * whom, and on what grounds" is answerable months later without
           * reconstructing state that no longer exists (SEC-12).
           */
          details: {
            audience: campaign.audienceDefinition,
            recipientCount: campaign.recipientCount ?? 0,
            excludedCount: campaign.excludedCount ?? 0,
            exclusionBreakdown: campaign.exclusionBreakdown,
            estimatedCostUsd: campaign.estimatedCostUsd ?? null,
            qualityWarning: gate.warning,
          },
        });

        if (!moved.ok) return new Response({ error: moved.reason }, { status: 409 });

        return new Response(
          { campaignId: campaign.id, status: moved.to, warning: gate.warning },
          { status: 200 },
        );
      }

      /**
       * Pausing stops the *next* batch. Messages already queued still send —
       * the queue cannot be recalled once a slot is scheduled, and pretending
       * otherwise would be a worse lie than the delay it hides. The response
       * says so, and the UI repeats it.
       */
      case 'pause': {
        requireRole(caller, 'admin');

        const moved = await transitionCampaign({
          campaign: loaded!.campaign,
          to: CAMPAIGN_STATUS.PAUSED,
          reason: STATUS_REASON.PAUSED_BY_ADMIN,
          actorId: caller.workspaceMemberId,
        });

        if (!moved.ok) return new Response({ error: moved.reason }, { status: 409 });

        return new Response(
          {
            campaignId: loaded!.campaign.id,
            status: CAMPAIGN_STATUS.PAUSED,
            changed: moved.changed,
            note: 'Messages already queued will still be delivered; pausing stops the next batch.',
          },
          { status: 200 },
        );
      }

      /**
       * Resume re-runs the launch gate rather than trusting that whatever
       * stopped the campaign has been fixed. A campaign paused for a RED
       * quality rating that resumed on the strength of an admin pressing a
       * button would send the next batch straight into the condition that
       * tripped it.
       */
      case 'resume': {
        requireRole(caller, 'admin');

        const { campaign, account, template } = loaded!;
        const refusal = templateRefusal(template);

        if (refusal !== null) return new Response({ error: refusal }, { status: 409 });

        const gate = launchGate(account, body.acknowledgeQuality === true);

        if (!gate.allowed) return new Response({ error: gate.reason }, { status: 409 });

        const moved = await transitionCampaign({
          campaign,
          to: CAMPAIGN_STATUS.RUNNING,
          reason: STATUS_REASON.RESUMED_BY_ADMIN,
          actorId: caller.workspaceMemberId,
        });

        if (!moved.ok) return new Response({ error: moved.reason }, { status: 409 });

        audit({
          action: AUDIT_ACTION.CAMPAIGN_RESUME,
          actorId: caller.workspaceMemberId,
          subject: { campaignId: campaign.id },
          details: { warning: gate.warning },
        });

        return new Response(
          { campaignId: campaign.id, status: CAMPAIGN_STATUS.RUNNING, warning: gate.warning },
          { status: 200 },
        );
      }

      case 'cancel': {
        requireRole(caller, 'admin');

        const { campaign } = loaded!;

        const moved = await transitionCampaign({
          campaign,
          to: CAMPAIGN_STATUS.CANCELLED,
          reason: STATUS_REASON.CANCELLED_BY_ADMIN,
          actorId: caller.workspaceMemberId,
          patch: { completedAt: new Date().toISOString() },
        });

        if (!moved.ok) return new Response({ error: moved.reason }, { status: 409 });

        /**
         * Unsent recipients are abandoned explicitly rather than left
         * `pending`: a row that still says pending in a cancelled campaign
         * reads, correctly, as work outstanding, and the next person to look at
         * the report would have to know the campaign's status to interpret its
         * own recipient list.
         */
        const abandoned = await abandonPending(campaign.id);

        return new Response(
          {
            campaignId: campaign.id,
            status: CAMPAIGN_STATUS.CANCELLED,
            abandoned,
            note: 'Messages already sent keep reporting their delivery status.',
          },
          { status: 200 },
        );
      }

      default:
        return new Response({ error: `Unknown action: ${String(action)}` }, { status: 400 });
    }
  } catch (error) {
    const authFailure = authErrorResponse(error);

    if (authFailure !== null) {
      return new Response(authFailure.body, { status: authFailure.status });
    }

    log.error('wa.campaign.route_failed', describeError(error));

    return new Response({ error: 'Internal error' }, { status: 500 });
  }
};

/**
 * Marks every unsent recipient `SKIPPED`, in pages.
 *
 * Bounded per call rather than unbounded: a cancelled 100 000-person campaign
 * would otherwise hold the request open for minutes. The runner will not touch
 * a cancelled campaign, so anything left is inert — and the loop below clears
 * it in one pass for every campaign a person is likely to cancel.
 */
const abandonPending = async (campaignId: string): Promise<number> => {
  let total = 0;

  for (let pass = 0; pass < 20; pass += 1) {
    const pending = await listRecipients({
      campaignId,
      statuses: [RECIPIENT_STATUS.PENDING, RECIPIENT_STATUS.CLAIMED],
      limit: 60,
    });

    if (pending.length === 0) break;

    await patchRecipients(
      pending.map((recipient) => recipient.id),
      {
        status: RECIPIENT_STATUS.SKIPPED,
        errorCode: 'CANCELLED',
        errorDetail: 'The campaign was cancelled before this message was sent',
        claimedAt: null,
      },
    );

    total += pending.length;
  }

  const remaining = await countRecipients(campaignId, [
    RECIPIENT_STATUS.PENDING,
    RECIPIENT_STATUS.CLAIMED,
  ]);

  if (remaining > 0) {
    logger.warn('wa.campaign.cancel_incomplete', { campaignId, remaining });
  }

  return total;
};

export default defineLogicFunction({
  universalIdentifier: LF_CAMPAIGN_CONTROL,
  name: 'wa-campaign-control',
  description:
    'Builds, previews, pre-flights, launches, pauses, resumes and cancels campaigns — admin-only and audited.',
  timeoutSeconds: 60,
  httpRouteTriggerSettings: {
    path: '/whatsapp/campaign',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
