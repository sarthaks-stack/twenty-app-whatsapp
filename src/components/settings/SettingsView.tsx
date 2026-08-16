import { useCallback, useEffect, useMemo, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { copyToClipboard } from 'twenty-sdk/front-component';
import { useTheme } from 'twenty-ui/theme-constants';

import { useCopy } from '../common/copy';
import { relativeTime } from '../common/format';
import { ActionButton, Banner, Card, Field, StatusPill, Tabs, useInputStyle } from '../common/ui';

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

const HEALTH_COPY: Record<string, { pt: string; remedy: string }> = {
  token: {
    pt: 'Token de acesso',
    remedy: 'A verificação horária não corre há mais de duas horas, ou falhou. Veja specs/11 §2.',
  },
  webhook: {
    pt: 'Webhook',
    remedy: 'Não chegam eventos há mais tempo do que o limite. Confirme a subscrição na Meta.',
  },
  quality: {
    pt: 'Qualidade do número',
    remedy: 'A Meta baixou a classificação. Reduza envios de marketing e reveja os modelos.',
  },
  tier: {
    pt: 'Escalão diário',
    remedy: 'A reserva para conversas 1:1 já consumiu o que resta — nenhuma campanha arranca hoje.',
  },
  failedWebhookEvents: {
    pt: 'Entregas falhadas (24h)',
    remedy: 'Há eventos por processar. Veja o separador Diagnóstico.',
  },
  stuckOutbound: {
    pt: 'Mensagens presas',
    remedy: 'Mensagens em fila há mais de 15 minutos. A verificação horária volta a tentar.',
  },
};

const Copyable = ({ label, value }: { label: string; value: string | null }) => {
  const theme = useTheme();

  if (value === null) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[2] }}>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' }}>
        <span style={{ fontSize: theme.font.size.xxs, color: theme.font.color.tertiary }}>
          {label}
        </span>
        <code
          style={{
            fontSize: theme.font.size.xs,
            color: theme.font.color.secondary,
            overflowX: 'auto',
            whiteSpace: 'nowrap',
          }}
        >
          {value}
        </code>
      </div>
      <ActionButton label="Copiar" onClick={() => void copyToClipboard(value)} />
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const post = useCallback(
    async <T,>(path: string, body: Record<string, unknown>): Promise<T | null> => {
      setBusy(true);
      setError(null);

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
        active={tab}
        onSelect={setTab}
        tabs={[
          { key: 'connection', label: 'Ligação' },
          { key: 'health', label: 'Saúde' },
          { key: 'templates', label: 'Modelos' },
          { key: 'diagnostics', label: 'Diagnóstico' },
        ]}
      />

      {error === null ? null : <Banner tone="danger">{error}</Banner>}
      {notice === null ? null : <Banner tone="success">{notice}</Banner>}

      {tab === 'connection' ? (
        <>
          {(data?.accounts ?? []).map((connected) => (
            <Card
              key={connected.id}
              title={`${connected.name ?? '—'} · ${connected.displayPhoneNumber ?? ''}`}
              actions={<StatusPill status={connected.status ?? null} />}
            >
              <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
                {connected.displayName ?? '—'} · qualidade {connected.qualityRating ?? '—'} ·
                escalão {connected.messagingLimitTier ?? '—'}
                {connected.isTestAccount === true ? ' · número de teste' : ''}
              </div>
              <Copyable label="phone_number_id" value={connected.phoneNumberId ?? null} />
              <Copyable label="WABA id" value={connected.wabaId ?? null} />

              <div style={{ display: 'flex', gap: theme.spacing[2], flexWrap: 'wrap' }}>
                <ActionButton
                  label="Testar ligação"
                  busy={busy}
                  onClick={async () => {
                    await post('/s/whatsapp/account', {
                      action: 'test',
                      accountId: connected.id,
                    });
                    setNotice('Ligação testada.');
                    void load();
                  }}
                />
                <ActionButton
                  label="Sincronizar modelos"
                  busy={busy}
                  onClick={async () => {
                    await post('/s/whatsapp/account', {
                      action: 'syncTemplates',
                      accountId: connected.id,
                    });
                    setNotice('Sincronização pedida.');
                  }}
                />
                <ActionButton
                  label="Desligar"
                  tone="danger"
                  busy={busy}
                  onClick={async () => {
                    await post('/s/whatsapp/account', {
                      action: 'disconnect',
                      accountId: connected.id,
                    });
                    void load();
                  }}
                />
              </div>
            </Card>
          ))}

          <Card title="Ligar um número">
            <Field label="Nome">
              <input
                type="text"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                style={input}
              />
            </Field>
            <Field label="phone_number_id" hint="Meta → WhatsApp → API Setup.">
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
            <Field label="Indicativo por omissão">
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
                gap: theme.spacing[1],
                fontSize: theme.font.size.xs,
                color: theme.font.color.secondary,
              }}
            >
              <input
                type="checkbox"
                checked={form.isTestAccount}
                onChange={(event) => setForm({ ...form, isTestAccount: event.target.checked })}
              />
              É um número de teste
            </label>
            <ActionButton
              label="Ligar"
              tone="primary"
              busy={busy}
              disabled={form.phoneNumberId === '' || form.wabaId === ''}
              onClick={async () => {
                await post('/s/whatsapp/account', { action: 'connect', ...form });
                void load();
              }}
            />
          </Card>

          <Card title="Callback da Meta">
            <Copyable label="URL do callback" value={data?.webhook.callbackUrl ?? null} />
            <Copyable label="Forma directa" value={data?.webhook.directUrl ?? null} />
            <Copyable label="URL de verificação" value={data?.webhook.verifyUrl ?? null} />
            <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
              Token de verificação:{' '}
              {data?.webhook.verifyTokenConfigured === true
                ? 'configurado na variável de servidor META_VERIFY_TOKEN'
                : '⚠ em falta — defina META_VERIFY_TOKEN'}
            </div>
            <div style={{ fontSize: theme.font.size.xxs, color: theme.font.color.tertiary }}>
              Campos a subscrever: {(data?.webhook.requiredFields ?? []).join(', ')}
            </div>
            <ActionButton
              label="Copiar lista de campos"
              onClick={() =>
                void copyToClipboard((data?.webhook.requiredFields ?? []).join('\n'))
              }
            />
          </Card>
        </>
      ) : null}

      {tab === 'health' ? (
        <Card title="Saúde">
          {(data?.rows ?? []).length === 0 ? <Banner>A carregar…</Banner> : null}

          {Object.keys(HEALTH_COPY).map((key) =>
            rowsFor(key).map((row, index) => (
              <div
                key={`${key}-${index}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.spacing[0.5],
                  borderTop: `1px solid ${theme.border.color.light}`,
                  paddingTop: theme.spacing[1],
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.spacing[2],
                    fontSize: theme.font.size.xs,
                  }}
                >
                  <span aria-hidden="true">{row.ok ? '🟢' : '🔴'}</span>
                  <span>{HEALTH_COPY[key].pt}</span>
                  <span style={{ flex: '1 1 auto' }} />
                  <span
                    style={{
                      fontSize: theme.font.size.xxs,
                      color: theme.font.color.tertiary,
                    }}
                  >
                    {row.ok ? 'OK' : 'a precisar de atenção'}
                  </span>
                </div>

                <span
                  style={{ fontSize: theme.font.size.xxs, color: theme.font.color.tertiary }}
                >
                  {JSON.stringify(row.detail)}
                </span>

                {/* A red row that does not say what to do is a red light with no
                    instructions — the operator ends up reading the source. */}
                {row.ok ? null : (
                  <span
                    style={{ fontSize: theme.font.size.xxs, color: theme.font.color.danger }}
                  >
                    {HEALTH_COPY[key].remedy}
                  </span>
                )}
              </div>
            )),
          )}

          <ActionButton label="Actualizar" busy={busy} onClick={() => void load()} />
        </Card>
      ) : null}

      {tab === 'templates' ? (
        <Card
          title="Modelos"
          actions={<ActionButton label="Actualizar" busy={busy} onClick={() => void loadTemplates()} />}
        >
          {templates.length === 0 ? (
            <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
              Nenhum modelo sincronizado.
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
                paddingTop: theme.spacing[1],
                fontSize: theme.font.size.xs,
                flexWrap: 'wrap',
              }}
            >
              <span>{String(template.name ?? '—')}</span>
              <span style={{ color: theme.font.color.tertiary }}>
                {String(template.language ?? '')} · {String(template.category ?? '')}
              </span>
              <StatusPill status={(template.status ?? null) as string | null} />
              {template.qualityScore === null || template.qualityScore === undefined ? null : (
                <span style={{ color: theme.font.color.tertiary }}>
                  {String(template.qualityScore)}
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
                  label="Despublicar"
                  busy={busy}
                  onClick={async () => {
                    await post('/s/whatsapp/template', {
                      action: 'unpublish',
                      templateId: template.id,
                    });
                    void loadTemplates();
                  }}
                />
              ) : (
                <ActionButton
                  label="Publicar"
                  tone="primary"
                  busy={busy}
                  disabled={template.publishRefusal !== null}
                  onClick={async () => {
                    await post('/s/whatsapp/template', {
                      action: 'publish',
                      templateId: template.id,
                    });
                    void loadTemplates();
                  }}
                />
              )}

              {template.publishRefusal === null ? null : (
                <span
                  style={{
                    width: '100%',
                    fontSize: theme.font.size.xxs,
                    color: theme.font.color.tertiary,
                  }}
                >
                  {String(template.publishRefusal)}
                </span>
              )}
            </div>
          ))}
        </Card>
      ) : null}

      {tab === 'diagnostics' ? (
        <>
          <Card title="Entregas falhadas (24h)">
            {(data?.failedEvents ?? []).length === 0 ? (
              <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
                Nenhuma.
              </span>
            ) : null}
            {(data?.failedEvents ?? []).map((event) => (
              <div
                key={String(event.id)}
                style={{
                  fontSize: theme.font.size.xxs,
                  color: theme.font.color.secondary,
                  borderTop: `1px solid ${theme.border.color.light}`,
                  paddingTop: theme.spacing[1],
                }}
              >
                {String(event.webhookField ?? '—')} ·{' '}
                {relativeTime(event.receivedAt as string | null, now, lang)} ·{' '}
                {String(event.error ?? '')} · tentativas {Number(event.attemptCount ?? 0)}
              </div>
            ))}
          </Card>

          <Card title="Mensagens presas">
            {(data?.stuckOutbound ?? []).length === 0 ? (
              <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
                Nenhuma.
              </span>
            ) : null}
            {(data?.stuckOutbound ?? []).map((message) => (
              <div
                key={String(message.id)}
                style={{ fontSize: theme.font.size.xxs, color: theme.font.color.secondary }}
              >
                {String(message.id)} ·{' '}
                {relativeTime(message.createdAt as string | null, now, lang)}
              </div>
            ))}
          </Card>

          <Card title="Consentimento">
            <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
              As palavras-chave de subscrição e cancelamento, e o texto da confirmação, são
              variáveis da aplicação — edite-as em Definições → Aplicações → WhatsApp →
              Variáveis. Estão fora deste ecrã de propósito: o texto é revisto por
              aconselhamento jurídico e uma alteração não deve exigir um deploy.
            </span>
          </Card>
        </>
      ) : null}

      <span style={{ fontSize: theme.font.size.xxs, color: theme.font.color.tertiary }}>
        {t('chat.testAccount')}: {account?.isTestAccount === true ? 'sim' : 'não'}
      </span>
    </div>
  );
};
