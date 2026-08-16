import { useCallback, useEffect, useMemo, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { copyToClipboard } from 'twenty-sdk/front-component';
import { Tag } from 'twenty-ui/data-display';
import { useTheme } from 'twenty-ui/theme-constants';

import { useCopy } from '../common/copy';
import { relativeTime } from '../common/format';
import {
  ActionButton,
  Banner,
  Card,
  Field,
  StatusPill,
  TabPanel,
  Tabs,
  useInputStyle,
} from '../common/ui';
import { describeHealth } from './health-detail';
import { VariablesPanel, type EditableVariable } from './VariablesPanel';

/**
 * *Settings → Applications → WhatsApp* (FR-ACC-1 … FR-ACC-5, NFR-O3).
 *
 * The operator's surface, and the only one that talks to the admin routes
 * rather than the feed. Everything it shows is admin-shaped — the routing
 * identity of the number, the health rows, the failed webhook deliveries — and
 * every route it calls re-checks the admin role regardless of what this
 * component chose to render.
 *
 * The verify token is never displayed. The card says whether one is configured
 * and nothing more: a settings page that printed it would put a secret into
 * every screenshot attached to a support ticket.
 */

type Account = Record<string, any>;
type HealthRow = { key: string; ok: boolean; detail: Record<string, any> };

type Diagnostics = {
  accounts: Account[];
  rows: HealthRow[];
  webhook: {
    callbackUrl: string | null;
    directUrl: string | null;
    verifyUrl: string | null;
    verifyTokenConfigured: boolean;
    requiredFields: string[];
  };
  failedEvents: Record<string, any>[];
  stuckOutbound: Record<string, any>[];
};

/**
 * The order the panel reads in, and the only place a row key is written down.
 * Each has a `settings.health.<key>` name and a `.remedy` in the catalog: a red
 * light with no instructions sends the operator to the source code.
 */
const HEALTH_KEYS = [
  'token',
  'webhook',
  'quality',
  'tier',
  'failedWebhookEvents',
  'stuckOutbound',
] as const;

const Copyable = ({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string | null;
  copyLabel: string;
}) => {
  const theme = useTheme();

  if (value === null) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[2] }}>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' }}>
        <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.light }}>
          {label}
        </span>
        <code
          style={{
            fontSize: theme.font.size.sm,
            color: theme.font.color.secondary,
            overflowX: 'auto',
            whiteSpace: 'nowrap',
          }}
        >
          {value}
        </code>
      </div>
      <ActionButton label={copyLabel} onClick={() => void copyToClipboard(value)} />
    </div>
  );
};

export const SettingsView = () => {
  const theme = useTheme();
  const input = useInputStyle();
  const { t, lang } = useCopy();

  const client = useMemo(() => new RestApiClient(), []);
  const [tab, setTab] = useState('connection');
  const [data, setData] = useState<Diagnostics | null>(null);
  const [templates, setTemplates] = useState<Record<string, any>[]>([]);
  const [variables, setVariables] = useState<EditableVariable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The account id whose disconnect is one click from happening. No portals
   * means no modal, so the confirmation is an inline second step: the danger
   * button arms it, and only the explicit confirm actually posts.
   */
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: '',
    wabaId: '',
    phoneNumberId: '',
    defaultCountryCallingCode: '+244',
    isTestAccount: false,
    subscribeApp: true,
  });

  const account = data?.accounts[0] ?? null;
  const now = new Date();

  /**
   * Returns `null` **and only null** when the request failed, having already
   * put the reason on screen. Every caller must check it before claiming
   * anything happened: the Test and Sync buttons used to announce success
   * unconditionally, so a refused request showed the operator a red error and a
   * green confirmation of the same click.
   *
   * It clears the previous notice too. A success message left over from the
   * last action is indistinguishable from one about this one.
   */
  const post = useCallback(
    async <T,>(path: string, body: Record<string, unknown>): Promise<T | null> => {
      setBusy(true);
      setError(null);
      setNotice(null);

      try {
        return await client.post<T>(path, body);
      } catch (caught) {
        const detail = caught as { body?: { error?: string } };

        setError(
          detail?.body?.error ??
            (caught instanceof Error ? caught.message : String(caught)),
        );

        return null;
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  const load = useCallback(async () => {
    const result = await post<Diagnostics>('/s/whatsapp/account', { action: 'diagnostics' });

    if (result !== null) setData(result);
  }, [post]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadTemplates = useCallback(async () => {
    if (account === null) return;

    const result = await post<{ templates: Record<string, any>[] }>('/s/whatsapp/template', {
      action: 'list',
      accountId: account.id,
    });

    if (result !== null) setTemplates(result.templates);
  }, [account, post]);

  useEffect(() => {
    if (tab === 'templates') void loadTemplates();
  }, [tab, loadTemplates]);

  const loadVariables = useCallback(async () => {
    const result = await post<{ variables: EditableVariable[] }>('/s/whatsapp/account', {
      action: 'variables',
    });

    if (result !== null) setVariables(result.variables);
  }, [post]);

  useEffect(() => {
    if (tab === 'variables') void loadVariables();
  }, [tab, loadVariables]);

  const rowsFor = (key: string): HealthRow[] =>
    (data?.rows ?? []).filter((row) => row.key === key);

  return (
    <div
      className="wa-settings"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        background: theme.background.primary,
        color: theme.font.color.primary,
        fontFamily: theme.font.family,
        padding: theme.spacing[2],
      }}
    >
      <Tabs
        group="settings"
        label={t('settings.tab.connection')}
        active={tab}
        onSelect={setTab}
        tabs={[
          { key: 'connection', label: t('settings.tab.connection') },
          { key: 'health', label: t('settings.tab.health') },
          { key: 'templates', label: t('settings.tab.templates') },
          { key: 'variables', label: t('settings.tab.variables') },
          { key: 'diagnostics', label: t('settings.tab.diagnostics') },
        ]}
      />

      {error === null ? null : <Banner tone="danger">{error}</Banner>}
      {notice === null ? null : <Banner tone="success">{notice}</Banner>}

      {tab === 'connection' ? (
        <TabPanel group="settings" tabKey="connection">
          {(data?.accounts ?? []).map((connected) => (
            <Card
              key={connected.id}
              title={`${connected.name ?? '—'} · ${connected.displayPhoneNumber ?? ''}`}
              actions={<StatusPill status={connected.status ?? null} />}
            >
              <div style={{ fontSize: theme.font.size.md, color: theme.font.color.secondary }}>
                {t('settings.summary', {
                  displayName: String(connected.displayName ?? '—'),
                  quality: String(connected.qualityRating ?? '—'),
                  tier: String(connected.messagingLimitTier ?? '—'),
                })}
                {connected.isTestAccount === true ? ` · ${t('chat.testAccount')}` : ''}
              </div>
              <Copyable
                label="phone_number_id"
                value={connected.phoneNumberId ?? null}
                copyLabel={t('common.copy')}
              />
              <Copyable
                label="WABA id"
                value={connected.wabaId ?? null}
                copyLabel={t('common.copy')}
              />

              <div style={{ display: 'flex', gap: theme.spacing[2], flexWrap: 'wrap' }}>
                <ActionButton
                  label={t('settings.test')}
                  busy={busy}
                  onClick={async () => {
                    const tested = await post('/s/whatsapp/account', {
                      action: 'test',
                      accountId: connected.id,
                    });

                    if (tested === null) return;

                    setNotice(t('settings.tested'));
                    void load();
                  }}
                />
                <ActionButton
                  label={t('settings.syncTemplates')}
                  busy={busy}
                  onClick={async () => {
                    const requested = await post('/s/whatsapp/account', {
                      action: 'syncTemplates',
                      accountId: connected.id,
                    });

                    if (requested === null) return;

                    setNotice(t('settings.syncRequested'));
                  }}
                />
              </div>

              {/*
                Disconnect is not a third maintenance shortcut: it lives alone
                below a divider, says what it will cost, and takes two clicks.
              */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.spacing[2],
                  borderTop: `1px solid ${theme.border.color.light}`,
                  paddingTop: theme.spacing[2],
                  marginTop: theme.spacing[1],
                }}
              >
                <span
                  style={{
                    fontSize: theme.font.size.sm,
                    fontWeight: theme.font.weight.medium,
                    color: theme.font.color.danger,
                  }}
                >
                  {t('settings.dangerZone')}
                </span>
                <span style={{ fontSize: theme.font.size.md, color: theme.font.color.secondary }}>
                  {t('settings.disconnectWarning')}
                </span>
                {confirmingDisconnect === connected.id ? (
                  <div style={{ display: 'flex', gap: theme.spacing[2], flexWrap: 'wrap' }}>
                    <ActionButton
                      label={t('settings.disconnectConfirm')}
                      tone="danger"
                      busy={busy}
                      onClick={async () => {
                        const disconnected = await post('/s/whatsapp/account', {
                          action: 'disconnect',
                          accountId: connected.id,
                        });

                        setConfirmingDisconnect(null);

                        // Reloading after a failure would immediately clear the
                        // error the failure just wrote — the operator sees a
                        // flash and nothing else.
                        if (disconnected !== null) void load();
                      }}
                    />
                    <ActionButton
                      label={t('common.cancel')}
                      onClick={() => setConfirmingDisconnect(null)}
                    />
                  </div>
                ) : (
                  <div style={{ display: 'flex' }}>
                    <ActionButton
                      label={t('settings.disconnect')}
                      tone="danger"
                      busy={busy}
                      onClick={() => setConfirmingDisconnect(connected.id)}
                    />
                  </div>
                )}
              </div>
            </Card>
          ))}

          <Card title={t('settings.connectTitle')}>
            <Field label={t('settings.name')}>
              <input
                type="text"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                style={input}
              />
            </Field>
            <Field label="phone_number_id" hint={t('settings.phoneNumberIdHint')}>
              <input
                type="text"
                value={form.phoneNumberId}
                onChange={(event) => setForm({ ...form, phoneNumberId: event.target.value })}
                style={input}
              />
            </Field>
            <Field label="WABA id">
              <input
                type="text"
                value={form.wabaId}
                onChange={(event) => setForm({ ...form, wabaId: event.target.value })}
                style={input}
              />
            </Field>
            <Field label={t('settings.callingCode')}>
              <input
                type="text"
                value={form.defaultCountryCallingCode}
                onChange={(event) =>
                  setForm({ ...form, defaultCountryCallingCode: event.target.value })
                }
                style={input}
              />
            </Field>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: theme.spacing[2],
                fontSize: theme.font.size.md,
                color: theme.font.color.secondary,
              }}
            >
              <input
                type="checkbox"
                checked={form.isTestAccount}
                onChange={(event) => setForm({ ...form, isTestAccount: event.target.checked })}
              />
              {t('settings.isTestAccount')}
            </label>
            <ActionButton
              label={t('settings.connect')}
              tone="primary"
              busy={busy}
              disabled={form.phoneNumberId === '' || form.wabaId === ''}
              onClick={async () => {
                const created = await post('/s/whatsapp/account', {
                  action: 'connect',
                  ...form,
                });

                if (created !== null) void load();
              }}
            />
          </Card>

          <Card title={t('settings.callback')}>
            <Copyable
              label={t('settings.callbackUrl')}
              value={data?.webhook.callbackUrl ?? null}
              copyLabel={t('common.copy')}
            />
            <Copyable
              label={t('settings.directUrl')}
              value={data?.webhook.directUrl ?? null}
              copyLabel={t('common.copy')}
            />
            <Copyable
              label={t('settings.verifyUrl')}
              value={data?.webhook.verifyUrl ?? null}
              copyLabel={t('common.copy')}
            />
            <div style={{ fontSize: theme.font.size.md, color: theme.font.color.secondary }}>
              {t('settings.verifyToken')}:{' '}
              {data?.webhook.verifyTokenConfigured === true
                ? t('settings.verifyTokenSet')
                : t('settings.verifyTokenMissing')}
            </div>
            <div style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}>
              {t('settings.requiredFields')}: {(data?.webhook.requiredFields ?? []).join(', ')}
            </div>
            <ActionButton
              label={t('settings.copyFields')}
              onClick={() =>
                void copyToClipboard((data?.webhook.requiredFields ?? []).join('\n'))
              }
            />
          </Card>
        </TabPanel>
      ) : null}

      {tab === 'health' ? (
        <TabPanel group="settings" tabKey="health">
        <Card
          title={t('settings.tab.health')}
          actions={
            <ActionButton label={t('common.refresh')} busy={busy} onClick={() => void load()} />
          }
        >
          {(data?.rows ?? []).length === 0 ? <Banner>{t('common.loading')}</Banner> : null}

          {HEALTH_KEYS.map((key) =>
            rowsFor(key).map((row, index) => (
              <div
                key={`${key}-${index}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.spacing[1],
                  borderTop: `1px solid ${theme.border.color.light}`,
                  paddingTop: theme.spacing[2],
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.spacing[2],
                    fontSize: theme.font.size.md,
                    fontWeight: theme.font.weight.medium,
                  }}
                >
                  <span>{t(`settings.health.${key}`)}</span>
                  <span style={{ flex: '1 1 auto' }} />
                  <Tag
                    color={row.ok ? 'green' : 'red'}
                    text={row.ok ? t('settings.ok') : t('settings.needsAttention')}
                    weight="medium"
                  />
                </div>

                <span
                  style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}
                >
                  {describeHealth(row.key, row.detail, t, lang)}
                </span>

                {/* A red row that does not say what to do is a red light with no
                    instructions — the operator ends up reading the source. */}
                {row.ok ? null : (
                  <span
                    style={{ fontSize: theme.font.size.sm, color: theme.font.color.danger }}
                  >
                    {t(`settings.health.${key}.remedy`)}
                  </span>
                )}
              </div>
            )),
          )}
        </Card>
        </TabPanel>
      ) : null}

      {tab === 'templates' ? (
        <TabPanel group="settings" tabKey="templates">
        <Card
          title={t('settings.tab.templates')}
          actions={
            <ActionButton
              label={t('common.refresh')}
              busy={busy}
              onClick={() => void loadTemplates()}
            />
          }
        >
          {templates.length === 0 ? (
            <span style={{ fontSize: theme.font.size.md, color: theme.font.color.tertiary }}>
              {t('settings.noTemplates')}
            </span>
          ) : null}

          {templates.map((template) => (
            <div
              key={String(template.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: theme.spacing[2],
                borderTop: `1px solid ${theme.border.color.light}`,
                paddingTop: theme.spacing[2],
                fontSize: theme.font.size.md,
                flexWrap: 'wrap',
              }}
            >
              <span>{String(template.name ?? '—')}</span>
              <span style={{ color: theme.font.color.tertiary }}>
                {String(template.language ?? '')} · {String(template.category ?? '')}
              </span>
              <StatusPill status={(template.status ?? null) as string | null} />
              {/*
                Meta reports `UNKNOWN` for any template without enough traffic
                to score, which is most of them on a new number. Printing the
                word next to a green APPROVED pill reads as a second, failing
                status; saying nothing is what "no score yet" looks like.
              */}
              {template.qualityScore === null ||
              template.qualityScore === undefined ||
              String(template.qualityScore).toUpperCase() === 'UNKNOWN' ? null : (
                <span style={{ color: theme.font.color.tertiary }}>
                  {t('settings.templateQuality', { score: String(template.qualityScore) })}
                </span>
              )}
              {template.unsupportedReason === null ||
              template.unsupportedReason === undefined ? null : (
                <span style={{ color: theme.font.color.danger }}>
                  {String(template.unsupportedReason)}
                </span>
              )}
              <span style={{ flex: '1 1 auto' }} />

              {template.publishedToCrm === true ? (
                <ActionButton
                  label={t('settings.unpublish')}
                  busy={busy}
                  onClick={async () => {
                    const unpublished = await post('/s/whatsapp/template', {
                      action: 'unpublish',
                      templateId: template.id,
                    });

                    if (unpublished !== null) void loadTemplates();
                  }}
                />
              ) : (
                <ActionButton
                  label={t('settings.publish')}
                  tone="primary"
                  busy={busy}
                  disabled={template.publishRefusal !== null}
                  onClick={async () => {
                    const published = await post('/s/whatsapp/template', {
                      action: 'publish',
                      templateId: template.id,
                    });

                    if (published !== null) void loadTemplates();
                  }}
                />
              )}

              {template.publishRefusal === null ? null : (
                <span
                  style={{
                    width: '100%',
                    fontSize: theme.font.size.sm,
                    color: theme.font.color.tertiary,
                  }}
                >
                  {String(template.publishRefusal)}
                </span>
              )}
            </div>
          ))}
        </Card>
        </TabPanel>
      ) : null}

      {tab === 'variables' ? (
        <TabPanel group="settings" tabKey="variables">
          <VariablesPanel
            variables={variables}
            busy={busy}
            t={t}
            onSave={async (key, value) => {
              const saved = await post<{ variables: EditableVariable[] }>(
                '/s/whatsapp/account',
                { action: 'setVariable', key, value },
              );

              if (saved === null) return false;

              setVariables(saved.variables);
              setNotice(t('settings.variableSaved', { key }));

              return true;
            }}
          />
        </TabPanel>
      ) : null}

      {tab === 'diagnostics' ? (
        <TabPanel group="settings" tabKey="diagnostics">
          <Card title={t('settings.failedEvents')}>
            {(data?.failedEvents ?? []).length === 0 ? (
              <span style={{ fontSize: theme.font.size.md, color: theme.font.color.tertiary }}>
                {t('common.none')}
              </span>
            ) : null}
            {(data?.failedEvents ?? []).map((event) => (
              <div
                key={String(event.id)}
                style={{
                  fontSize: theme.font.size.sm,
                  color: theme.font.color.secondary,
                  borderTop: `1px solid ${theme.border.color.light}`,
                  paddingTop: theme.spacing[1],
                }}
              >
                {String(event.webhookField ?? '—')} ·{' '}
                {relativeTime(event.receivedAt as string | null, now, lang)} ·{' '}
                {String(event.error ?? '')} · {t('settings.attempts')}{' '}
                {Number(event.attemptCount ?? 0)}
              </div>
            ))}
          </Card>

          <Card title={t('settings.stuckMessages')}>
            {(data?.stuckOutbound ?? []).length === 0 ? (
              <span style={{ fontSize: theme.font.size.md, color: theme.font.color.tertiary }}>
                {t('common.none')}
              </span>
            ) : null}
            {(data?.stuckOutbound ?? []).map((message) => (
              <div
                key={String(message.id)}
                style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}
              >
                {String(message.id)} ·{' '}
                {relativeTime(message.createdAt as string | null, now, lang)}
              </div>
            ))}
          </Card>

          <Card title={t('settings.consent')}>
            <span style={{ fontSize: theme.font.size.md, color: theme.font.color.tertiary }}>
              {t('settings.consentNote')}
            </span>
          </Card>
        </TabPanel>
      ) : null}

      <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}>
        {t('chat.testAccount')}: {t(account?.isTestAccount === true ? 'common.yes' : 'common.no')}
      </span>
    </div>
  );
};
