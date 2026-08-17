import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { AccountProjection } from '../../domain/feed/projection';
import { emptyParameters, renderTemplate } from '../../domain/template-render';
import type { VariableSpec } from '../../domain/template-spec';
import type { FeedTemplate } from '../common/use-feed';
import { useCopy, type Translate } from '../common/copy';
import { Glyph } from '../common/icons';
import { ActionButton, Banner, Card, Field, useInputStyle } from '../common/ui';
import { useCampaignActions } from './campaign-actions';

/**
 * The five-step builder (FR-CAM-1, specs/07 §2).
 *
 * **Every step from the second one persists.** Each "Continuar" writes the
 * draft through `create`/`update` before advancing, so a reload — or a widget
 * the host remounts, which happens — never loses work. Holding five steps of
 * state in a component and writing it once at the end is how a sandbox that
 * "can fail, often silently" costs someone an afternoon.
 *
 * The record cannot exist before step 2: `create` requires a template, because
 * a campaign without one has nothing to say and no cost to estimate. So step 1
 * is the only one held in memory, and it is two fields.
 *
 * **The audience is a choice between three shapes**, not a free-text box. Views
 * come from the server's own list, filtered to the types that are actually
 * lists of people; a UUID field would let an admin point a campaign at a record
 * page layout.
 *
 * **Variables bind to an allow-list.** `bindingPaths` is `ALLOWED_BINDING_PATHS`
 * from the resolver itself, so the dropdown cannot offer a path the snapshot
 * will refuse — and a rejected path renders as blank text, which Meta answers
 * with 132000 for every recipient.
 *
 * **Nothing is decided without seeing it.** A message preview rides along from
 * the template step onwards, and it gets more real as the builder learns more:
 * the bare template first, then the template with this campaign's own bindings
 * standing in, and finally — on Review — the text a named contact from the
 * actual audience is going to receive, rendered by the server with the same
 * function the snapshot uses.
 */

export type CampaignBuilderProps = {
  accounts: AccountProjection[];
  templates: FeedTemplate[];
  onDone: (campaignId: string) => void;
  onCancel: () => void;
};

type AudienceKind = 'view' | 'manual';

const STEPS = [
  'campaign.step.basics',
  'campaign.step.template',
  'campaign.step.audience',
  'campaign.step.variables',
  'campaign.step.review',
] as const;

const REVIEW_STEP = STEPS.length - 1;

/** Enough to be representative, few enough to read. */
const PREVIEW_SAMPLE = 5;

type Binding = { kind: 'field' | 'static'; path: string; value: string; fallback: string };

type PreviewRow = {
  personId: string | null;
  phone: string | null;
  ok: boolean;
  missing: string[];
  rendered: { header: string | null; body: string; footer: string | null };
};

const specOf = (template: FeedTemplate | undefined): VariableSpec | null =>
  template?.variableSpec === null || template?.variableSpec === undefined
    ? null
    : (template.variableSpec as unknown as VariableSpec);

/**
 * The last segment of a binding path, as a stand-in value.
 *
 * `person.name.firstName` reads as `«firstName»` in the preview. Not a real
 * value and not pretending to be one — the guillemets are there so nobody
 * mistakes it for the contact's actual name — but it puts the *shape* of the
 * finished sentence on screen while the mapping is still being edited, which
 * `{{1}}` never did.
 */
export const standIn = (binding: Binding): string => {
  if (binding.kind === 'static') {
    return binding.value.length > 0 ? binding.value : binding.fallback;
  }

  const leaf = binding.path.split('.').filter((part) => part.length > 0).pop();

  return leaf === undefined ? '' : `«${leaf}»`;
};

/**
 * What is wrong with the sending number, before anybody launches anything.
 *
 * Pure and exported: it is four independent conditions, three of them
 * survivable and one of them fatal, and getting "this campaign will not start"
 * confused with "this campaign is worth a second look" is the kind of thing a
 * test should hold still.
 */
export const accountWarnings = (account: AccountProjection | null): string[] => {
  if (account === null) return ['campaign.warnNotConnected'];

  return [
    account.status === 'CONNECTED' ? null : 'campaign.warnNotConnected',
    account.qualityRating === 'RED' ? 'campaign.warnQualityRed' : null,
    account.qualityRating === 'YELLOW' ? 'campaign.warnQualityYellow' : null,
    account.isTestAccount ? 'campaign.warnTestAccount' : null,
  ].filter((key): key is string => key !== null);
};

/** The dashed box every preview in this app renders into. */
const Preview = ({
  rendered,
  note,
  t,
}: {
  rendered: { header: string | null; body: string; footer: string | null };
  note?: string;
  t: Translate;
}) => {
  const theme = useTheme();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.spacing[1],
          fontSize: theme.font.size.sm,
          fontWeight: theme.font.weight.medium,
          color: theme.font.color.light,
        }}
      >
        <Glyph name="template" />
        {t('campaign.previewTitle')}
      </span>

      <div
        style={{
          border: `1px dashed ${theme.border.color.medium}`,
          borderRadius: theme.border.radius.sm,
          padding: theme.spacing[2],
          fontSize: theme.font.size.md,
          whiteSpace: 'pre-wrap',
          color: theme.font.color.secondary,
        }}
      >
        {rendered.header === null ? null : (
          <div style={{ fontWeight: theme.font.weight.semiBold }}>{rendered.header}</div>
        )}
        <div>{rendered.body}</div>
        {rendered.footer === null ? null : (
          <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
            {rendered.footer}
          </div>
        )}
      </div>

      {note === undefined ? null : (
        <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
          {note}
        </span>
      )}
    </div>
  );
};

const SummaryRow = ({ label, value }: { label: string; value: string }) => {
  const theme = useTheme();

  return (
    <div style={{ display: 'flex', gap: theme.spacing[2], flexWrap: 'wrap' }}>
      <span
        style={{
          flex: '0 0 160px',
          fontSize: theme.font.size.sm,
          color: theme.font.color.tertiary,
        }}
      >
        {label}
      </span>
      <span
        style={{
          flex: '1 1 200px',
          fontSize: theme.font.size.md,
          color: theme.font.color.primary,
        }}
      >
        {value}
      </span>
    </div>
  );
};

export const CampaignBuilder = ({
  accounts,
  templates,
  onDone,
  onCancel,
}: CampaignBuilderProps) => {
  const theme = useTheme();
  const input = useInputStyle();
  const { t } = useCopy();
  const { call } = useCampaignActions();

  const [step, setStep] = useState(0);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [scheduledAt, setScheduledAt] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [audienceKind, setAudienceKind] = useState<AudienceKind>('view');
  const [viewId, setViewId] = useState('');
  const [personIds, setPersonIds] = useState('');
  const [bindings, setBindings] = useState<Binding[]>([]);

  const [views, setViews] = useState<{ id: string; name: string }[]>([]);
  const [paths, setPaths] = useState<string[]>([]);
  const [sample, setSample] = useState<PreviewRow[] | null>(null);

  /**
   * Campaigns may only use marketing and utility templates. Authentication ones
   * are OTP-shaped — a one-time code sent to a list is either meaningless or a
   * security incident — so they are excluded here and refused again at launch.
   */
  const usable = useMemo(
    () =>
      templates.filter(
        (template) => template.category === 'MARKETING' || template.category === 'UTILITY',
      ),
    [templates],
  );

  const template = usable.find((candidate) => candidate.id === templateId);
  const spec = specOf(template);
  const account = accounts.find((candidate) => candidate.id === accountId) ?? null;

  const labels = useMemo(() => {
    if (spec === null) return [];

    return spec.namedParameters
      ? spec.body.names.map((n) => `{{${n}}}`)
      : spec.body.indices.map((i) => `{{${i}}}`);
  }, [spec]);

  useEffect(() => {
    void call<{ views: { id: string; name: string }[]; bindingPaths: string[] }>(
      'audienceOptions',
    ).then((result) => {
      if (result.ok) {
        setViews(result.data.views);
        setPaths(result.data.bindingPaths);
      }
    });
  }, [call]);

  // One binding row per placeholder, kept in step with the chosen template.
  useEffect(() => {
    setBindings((current) =>
      labels.map(
        (_, index) =>
          current[index] ?? { kind: 'field', path: paths[0] ?? '', value: '', fallback: '' },
      ),
    );
  }, [labels, paths]);

  const audienceDefinition = useMemo(() => {
    if (audienceKind === 'view') return viewId === '' ? null : { kind: 'view', viewId };

    const ids = personIds
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    return ids.length === 0 ? null : { kind: 'manual', personIds: ids };
  }, [audienceKind, personIds, viewId]);

  const variableMapping = useMemo(
    () => ({
      body: bindings.map((binding, index) => ({
        index: spec?.namedParameters === true ? index + 1 : (spec?.body.indices[index] ?? index + 1),
        kind: binding.kind,
        ...(binding.kind === 'field' ? { path: binding.path } : { value: binding.value }),
        ...(binding.fallback === '' ? {} : { fallback: binding.fallback }),
      })),
    }),
    [bindings, spec],
  );

  /** The template as it stands, with whatever the mapping can stand in for. */
  const localPreview = useMemo(
    () =>
      spec === null
        ? null
        : renderTemplate(spec, {
            ...emptyParameters(),
            body: bindings.map(standIn),
          }),
    [bindings, spec],
  );

  const persist = useCallback(
    async (patch: Record<string, unknown>): Promise<boolean> => {
      setBusy(true);
      setError(null);

      const result =
        campaignId === null
          ? await call<{ campaign?: { id?: string } }>('create', patch)
          : await call('update', { campaignId, ...patch });

      setBusy(false);

      if (!result.ok) {
        setError(result.error);

        return false;
      }

      if (campaignId === null) {
        const created = result.data as { campaign?: { id?: string } };
        const id = created.campaign?.id ?? null;

        if (id === null) {
          setError(t('campaign.createdNoId'));

          return false;
        }

        setCampaignId(id);
      }

      return true;
    },
    [call, campaignId, t],
  );

  /**
   * The real thing, rendered by the server against real contacts.
   *
   * Asked for once, on arriving at Review, and only after the mapping has been
   * written — `preview` reads the campaign record, so calling it before the
   * save would render the *previous* mapping and quietly show the wrong text
   * on the one screen whose whole job is to be right.
   */
  const loadSample = useCallback(
    async (id: string) => {
      const result = await call<{ rows: PreviewRow[] }>('preview', {
        campaignId: id,
        sampleSize: PREVIEW_SAMPLE,
      });

      setSample(result.ok ? result.data.rows : []);
    },
    [call],
  );

  const next = useCallback(async () => {
    // Step 0 is not written: `create` needs the template that step 1 chooses.
    if (step === 0) {
      setStep(1);

      return;
    }

    const patches: Record<number, Record<string, unknown>> = {
      1: {
        name,
        accountId,
        templateId,
        ...(scheduledAt === '' ? {} : { scheduledAt: new Date(scheduledAt).toISOString() }),
      },
      2: { audienceDefinition },
      3: { variableMapping },
    };

    if (!(await persist(patches[step]))) return;

    setStep((current) => current + 1);

    // Entering Review: the mapping is saved, so the sample will be current.
    if (step === 3 && campaignId !== null) {
      setSample(null);
      void loadSample(campaignId);
    }
  }, [
    accountId,
    audienceDefinition,
    campaignId,
    loadSample,
    name,
    persist,
    scheduledAt,
    step,
    templateId,
    variableMapping,
  ]);

  const build = useCallback(async () => {
    if (campaignId === null) return;

    setBusy(true);

    const result = await call('build', { campaignId });

    setBusy(false);

    if (!result.ok) {
      setError(result.error);

      return;
    }

    onDone(campaignId);
  }, [call, campaignId, onDone]);

  const canAdvance =
    step === 0
      ? name.trim().length > 0 && accountId !== ''
      : step === 1
        ? templateId !== ''
        : step === 2
          ? audienceDefinition !== null
          : true;

  const warnings = accountWarnings(account);
  const missingRows = (sample ?? []).filter((row) => !row.ok);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        /**
         * A form does not get better by being wider. Past roughly this the
         * label/control pairs drift apart until a select on the right belongs
         * to a label the eye has already left; the review measured full-width
         * fields on a 1400px screen.
         */
        maxWidth: '760px',
      }}
    >
      {/*
        The stepper at reading size: a numbered disc per step, filled for the
        current one, checked for the ones already persisted. Hierarchy comes
        from weight and fill, not from making the words smaller.
      */}
      <div
        style={{
          display: 'flex',
          gap: theme.spacing[3],
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {STEPS.map((key, index) => (
          <span
            key={key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: theme.spacing[1],
              fontSize: theme.font.size.md,
              color: index === step ? theme.font.color.primary : theme.font.color.tertiary,
              fontWeight:
                index === step ? theme.font.weight.semiBold : theme.font.weight.regular,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '20px',
                height: '20px',
                borderRadius: theme.border.radius.rounded,
                fontSize: theme.font.size.sm,
                background:
                  index === step ? theme.color.blue : theme.background.transparent.light,
                color:
                  index === step ? theme.font.color.inverted : theme.font.color.tertiary,
              }}
            >
              {index < step ? <Glyph name="completed" /> : index + 1}
            </span>
            {t(key)}
          </span>
        ))}
      </div>

      {error === null ? null : <Banner tone="danger">{error}</Banner>}

      <Card title={t(STEPS[step])}>
        {step === 0 ? (
          <>
            <Field label={t('campaign.name')}>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                style={input}
              />
            </Field>
            <Field label={t('campaign.account')}>
              <select
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                style={input}
              >
                {accounts.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} · {candidate.displayPhoneNumber ?? ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('campaign.schedule')} hint={t('campaign.scheduleHint')}>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
                style={input}
              />
            </Field>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <Field label={t('campaign.step.template')} hint={t('campaign.templateHint')}>
              <select
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                style={input}
              >
                <option value="">—</option>
                {usable.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} ({candidate.language}) · {candidate.category}
                  </option>
                ))}
              </select>
            </Field>

            {localPreview === null ? null : (
              <Preview
                rendered={localPreview}
                note={t('campaign.previewPlaceholders')}
                t={t}
              />
            )}
          </>
        ) : null}

        {step === 2 ? (
          <>
            <Field label={t('campaign.source')}>
              <select
                value={audienceKind}
                onChange={(event) => setAudienceKind(event.target.value as AudienceKind)}
                style={input}
              >
                <option value="view">{t('campaign.sourceView')}</option>
                <option value="manual">{t('campaign.sourceManual')}</option>
              </select>
            </Field>

            {audienceKind === 'view' ? (
              <Field label={t('campaign.view')}>
                <select
                  value={viewId}
                  onChange={(event) => setViewId(event.target.value)}
                  style={input}
                >
                  <option value="">—</option>
                  {views.map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label={t('campaign.personIds')} hint={t('campaign.personIdsHint')}>
                <textarea
                  rows={4}
                  value={personIds}
                  onChange={(event) => setPersonIds(event.target.value)}
                  style={{ ...input, resize: 'vertical' }}
                />
              </Field>
            )}
          </>
        ) : null}

        {step === 3 ? (
          <>
            {labels.length === 0 ? (
              <span style={{ fontSize: theme.font.size.md, color: theme.font.color.tertiary }}>
                {t('campaign.noVariables')}
              </span>
            ) : null}

            {labels.map((label, index) => {
              const binding = bindings[index] ?? {
                kind: 'field' as const,
                path: '',
                value: '',
                fallback: '',
              };

              const update = (patch: Partial<Binding>) =>
                setBindings((current) =>
                  current.map((row, position) =>
                    position === index ? { ...row, ...patch } : row,
                  ),
                );

              return (
                <Card key={label} title={label}>
                  <Field label={t('campaign.source')}>
                    <select
                      value={binding.kind}
                      onChange={(event) =>
                        update({ kind: event.target.value as 'field' | 'static' })
                      }
                      style={input}
                    >
                      <option value="field">{t('campaign.bindingField')}</option>
                      <option value="static">{t('campaign.bindingStatic')}</option>
                    </select>
                  </Field>

                  {binding.kind === 'field' ? (
                    <Field label={t('campaign.field')}>
                      <select
                        value={binding.path}
                        onChange={(event) => update({ path: event.target.value })}
                        style={input}
                      >
                        {paths.map((path) => (
                          <option key={path} value={path}>
                            {path}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : (
                    <Field label={t('campaign.text')}>
                      <input
                        type="text"
                        value={binding.value}
                        onChange={(event) => update({ value: event.target.value })}
                        style={input}
                      />
                    </Field>
                  )}

                  <Field label={t('campaign.fallback')} hint={t('campaign.fallbackHint')}>
                    <input
                      type="text"
                      value={binding.fallback}
                      onChange={(event) => update({ fallback: event.target.value })}
                      style={input}
                    />
                  </Field>
                </Card>
              );
            })}

            {/*
              Live, and local. Every keystroke re-renders it, which no server
              call could survive — and it is honest about what it is: a static
              binding shows its own text, a field binding shows the field's
              name in guillemets. The real values arrive on the next screen.
            */}
            {localPreview === null ? null : <Preview rendered={localPreview} t={t} />}
          </>
        ) : null}

        {step === REVIEW_STEP ? (
          <>
            <SummaryRow label={t('campaign.name')} value={name} />
            <SummaryRow
              label={t('campaign.account')}
              value={`${account?.name ?? '—'} · ${account?.displayPhoneNumber ?? ''}`}
            />
            <SummaryRow
              label={t('campaign.step.template')}
              value={
                template === undefined
                  ? '—'
                  : `${template.name} (${template.language}) · ${template.category}`
              }
            />
            <SummaryRow
              label={t('campaign.step.audience')}
              value={
                audienceKind === 'view'
                  ? t('campaign.reviewAudienceView', {
                      name: views.find((view) => view.id === viewId)?.name ?? viewId,
                    })
                  : t('campaign.reviewAudienceManual', {
                      count: personIds.split(/[\s,]+/).filter((id) => id.trim().length > 0)
                        .length,
                    })
              }
            />
            <SummaryRow
              label={t('campaign.schedule')}
              value={
                scheduledAt === ''
                  ? t('campaign.reviewScheduleNow')
                  : new Date(scheduledAt).toLocaleString()
              }
            />

            {warnings.length === 0 ? null : (
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}
              >
                <span
                  style={{
                    fontSize: theme.font.size.sm,
                    fontWeight: theme.font.weight.medium,
                    color: theme.font.color.light,
                  }}
                >
                  {t('campaign.reviewWarnings')}
                </span>
                {warnings.map((key) => (
                  <span
                    key={key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: theme.spacing[1],
                      fontSize: theme.font.size.sm,
                      color:
                        key === 'campaign.warnNotConnected'
                          ? theme.font.color.danger
                          : theme.font.color.secondary,
                    }}
                  >
                    <Glyph name="warning" />
                    {t(key)}
                  </span>
                ))}
              </div>
            )}

            {sample === null ? (
              <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}>
                {t('common.loading')}
              </span>
            ) : sample.length === 0 ? (
              <Banner>{t('campaign.previewUnavailable')}</Banner>
            ) : (
              <>
                <Preview
                  rendered={sample[0].rendered}
                  note={t('campaign.previewSample', {
                    name: sample[0].phone ?? sample[0].personId ?? '?',
                  })}
                  t={t}
                />

                {/*
                  A missing variable is not a formatting problem — the snapshot
                  excludes that contact outright (specs/07). Saying so here,
                  against a real sample, is the difference between finding out
                  now and finding out from the exclusion breakdown after the
                  build.
                */}
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.spacing[1],
                    fontSize: theme.font.size.sm,
                    color:
                      missingRows.length === 0
                        ? theme.font.color.secondary
                        : theme.font.color.danger,
                  }}
                >
                  <Glyph name={missingRows.length === 0 ? 'completed' : 'warning'} />
                  {missingRows.length === 0
                    ? t('campaign.reviewNoMissing')
                    : t('campaign.reviewMissing', {
                        count: missingRows.length,
                        total: sample.length,
                        keys: [
                          ...new Set(missingRows.flatMap((row) => row.missing)),
                        ].join(', '),
                      })}
                </span>
              </>
            )}

            <Banner>{t('campaign.reviewCountUnknown')}</Banner>
          </>
        ) : null}
      </Card>

      {/*
        Sticky, because the Variables step is as long as the template has
        placeholders and the Review step is longer still — the controls that
        end the flow were at the bottom of a scroll on every step that needed
        them most.
      */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[2],
          position: 'sticky',
          bottom: 0,
          background: theme.background.primary,
          borderTop: `1px solid ${theme.border.color.light}`,
          padding: `${theme.spacing[2]} 0`,
        }}
      >
        {step > 0 ? (
          <ActionButton
            label={t('common.back')}
            icon="back"
            onClick={() => setStep((current) => current - 1)}
          />
        ) : null}
        <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
          {t('campaign.stepOf', { step: step + 1, total: STEPS.length })}
        </span>
        <span style={{ flex: '1 1 auto' }} />
        <ActionButton label={t('common.cancel')} onClick={onCancel} />
        {step < REVIEW_STEP ? (
          <ActionButton
            label={t('common.continue')}
            tone="primary"
            busy={busy}
            disabled={!canAdvance}
            onClick={() => void next()}
          />
        ) : (
          <ActionButton
            label={t('campaign.build')}
            tone="primary"
            icon="audience"
            busy={busy}
            onClick={() => void build()}
          />
        )}
      </div>
    </div>
  );
};
