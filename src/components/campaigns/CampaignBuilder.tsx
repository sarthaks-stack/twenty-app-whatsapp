import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { AccountProjection } from '../../domain/feed/projection';
import type { VariableSpec } from '../../domain/template-spec';
import type { FeedTemplate } from '../common/use-feed';
import { useCopy } from '../common/copy';
import { ActionButton, Banner, Card, Field, useInputStyle } from '../common/ui';
import { useCampaignActions } from './campaign-actions';

/**
 * The four-step builder (FR-CAM-1, specs/07 §2).
 *
 * **Every step from the second one persists.** Each "Continuar" writes the
 * draft through `create`/`update` before advancing, so a reload — or a widget
 * the host remounts, which happens — never loses work. Holding four steps of
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
] as const;

const specOf = (template: FeedTemplate | undefined): VariableSpec | null =>
  template?.variableSpec === null || template?.variableSpec === undefined
    ? null
    : (template.variableSpec as unknown as VariableSpec);

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
  const [bindings, setBindings] = useState<
    { kind: 'field' | 'static'; path: string; value: string; fallback: string }[]
  >([]);

  const [views, setViews] = useState<{ id: string; name: string }[]>([]);
  const [paths, setPaths] = useState<string[]>([]);

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

  const spec = specOf(usable.find((template) => template.id === templateId));

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

    if (await persist(patches[step])) setStep((current) => current + 1);
  }, [
    accountId,
    audienceDefinition,
    name,
    persist,
    scheduledAt,
    step,
    templateId,
    variableMapping,
  ]);

  const build = useCallback(async () => {
    if (!(await persist({ variableMapping }))) return;
    if (campaignId === null) return;

    setBusy(true);

    const result = await call('build', { campaignId });

    setBusy(false);

    if (!result.ok) {
      setError(result.error);

      return;
    }

    onDone(campaignId);
  }, [call, campaignId, onDone, persist, variableMapping]);

  const canAdvance =
    step === 0
      ? name.trim().length > 0 && accountId !== ''
      : step === 1
        ? templateId !== ''
        : step === 2
          ? audienceDefinition !== null
          : true;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[2] }}>
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
              {index < step ? '✓' : index + 1}
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
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.displayPhoneNumber ?? ''}
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
          <Field label={t('campaign.step.template')} hint={t('campaign.templateHint')}>
            <select
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
              style={input}
            >
              <option value="">—</option>
              {usable.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} ({template.language}) · {template.category}
                </option>
              ))}
            </select>
          </Field>
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

              const update = (patch: Partial<typeof binding>) =>
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
          </>
        ) : null}
      </Card>

      <div style={{ display: 'flex', gap: theme.spacing[2] }}>
        {step > 0 ? (
          <ActionButton
            label={t('common.back')}
            onClick={() => setStep((current) => current - 1)}
          />
        ) : null}
        <span style={{ flex: '1 1 auto' }} />
        <ActionButton label={t('common.cancel')} onClick={onCancel} />
        {step < STEPS.length - 1 ? (
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
            busy={busy}
            onClick={() => void build()}
          />
        )}
      </div>
    </div>
  );
};
