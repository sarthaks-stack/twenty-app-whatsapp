import { useCallback, useEffect, useState } from 'react';
import { openCommandConfirmationModal } from 'twenty-sdk/front-component';
import { useTheme } from 'twenty-ui/theme-constants';

import type { Translate } from '../common/copy';
import { ActionButton, Banner, Card, StatusPill } from '../common/ui';
import { useCampaignActions } from './campaign-actions';

/**
 * One campaign: what it will cost, who it will miss, and how to stop it
 * (FR-CAM-6, FR-CAM-8, FR-CAM-10, specs/07 §5).
 *
 * The pre-flight panel is the point of this screen. Everything on it is a
 * number the server computed from the snapshot that will actually be sent —
 * the exclusion breakdown with samples, the cost estimate at the template's own
 * category rate, the tier spread, and the quality gate. A launch button beside
 * a number nobody computed is how a campaign to 40 000 people gets approved by
 * someone who thought it was 400.
 *
 * Pause, resume and cancel go behind the host's confirmation modal — they are
 * the controls a person reaches for while something is going wrong, which is
 * exactly when a misclick is most likely.
 */

export type CampaignDetailProps = {
  campaign: Record<string, any>;
  recipients: Record<string, any>[];
  canManage: boolean;
  t: Translate;
  onBack: () => void;
  onChanged: () => void;
};

type Preflight = {
  recipients: {
    total: number;
    excluded: number;
    breakdown: Record<string, number>;
    samples: Record<string, { personId: string | null; phone: string | null }[]>;
  };
  cost: { estimatedUsd: number; ratePerMessageUsd: number; note: string };
  tier: {
    tier: string;
    limit: number;
    used: number;
    reserve: number;
    available: number;
    /** `days: Infinity` serialises as null — a campaign that cannot start today. */
    spread: { firstDay: number; days: number | null };
  } | null;
  quality: { rating: string; gate: { allowed: boolean; reason?: string } };
  template: { name: string | null; language: string | null; category: string | null; refusal: string | null } | null;
  preview: { rendered: { header: string | null; body: string; footer: string | null } }[];
};

const COUNTERS = [
  'recipientCount',
  'queuedCount',
  'sentCount',
  'deliveredCount',
  'readCount',
  'respondedCount',
  'failedCount',
  'skippedCount',
  'excludedCount',
] as const;

export const CampaignDetail = ({
  campaign,
  recipients,
  canManage,
  t,
  onBack,
  onChanged,
}: CampaignDetailProps) => {
  const theme = useTheme();
  const { call } = useCampaignActions();

  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledgeQuality, setAcknowledgeQuality] = useState(false);

  const campaignId = campaign.id as string;
  const status = (campaign.status ?? null) as string | null;

  useEffect(() => {
    void call<Preflight>('preflight', { campaignId }).then((result) => {
      if (result.ok) setPreflight(result.data);
      else setError(result.error);
    });
  }, [call, campaignId]);

  const run = useCallback(
    async (action: Parameters<typeof call>[0], body: Record<string, unknown> = {}) => {
      setBusy(true);
      setError(null);

      const result = await call(action, { campaignId, ...body });

      setBusy(false);

      if (!result.ok) setError(result.error);
      else onChanged();
    },
    [call, campaignId, onChanged],
  );

  /**
   * The host's modal, not a `window.confirm`: a browser dialog blocks the
   * worker's whole message channel, and the extension never gets another
   * command until someone dismisses it by hand.
   */
  const confirmThen = useCallback(
    async (
      title: string,
      subtitle: string,
      action: Parameters<typeof call>[0],
      accent: 'default' | 'danger' = 'default',
    ) => {
      const answer = await openCommandConfirmationModal({
        title,
        subtitle,
        confirmButtonText: title,
        confirmButtonAccent: accent,
      });

      // Anything that is not an explicit confirmation is a refusal, including a
      // dialog the host closed for its own reasons.
      if (answer === 'confirm') await run(action);
    },
    [run],
  );

  const label = { fontSize: theme.font.size.xxs, color: theme.font.color.tertiary };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[2] }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[2] }}>
        <ActionButton label={`← ${t('campaign.title')}`} onClick={onBack} />
        <span
          style={{
            fontWeight: theme.font.weight.semiBold,
            fontSize: theme.font.size.md,
            color: theme.font.color.primary,
          }}
        >
          {campaign.name ?? '—'}
        </span>
        <StatusPill status={status} />
        <span style={{ flex: '1 1 auto' }} />

        {/*
          Launch is gated on the preflight having *arrived*, not merely on the
          status being READY. Without that the confirmation offers "0
          recipients, $0.00" — numbers that belong to no campaign — and the
          operator confirms a send whose size they were never shown.

          A refused quality gate removes this button entirely rather than
          disabling it: there is a deliberate path for that case further down,
          behind an acknowledgement, and two ways to do the same dangerous thing
          is one too many.
        */}
        {canManage && status === 'READY' && preflight !== null && preflight.quality.gate.allowed ? (
          <ActionButton
            label={t('campaign.launch')}
            tone="primary"
            busy={busy}
            onClick={() =>
              void confirmThen(
                t('campaign.launch'),
                t('campaign.launchSubtitle', {
                  count: preflight.recipients.total,
                  cost: preflight.cost.estimatedUsd.toFixed(2),
                }),
                'launch',
              )
            }
          />
        ) : null}
        {canManage && (status === 'RUNNING' || status === 'TIER_WAITING') ? (
          <ActionButton
            label={t('campaign.pause')}
            busy={busy}
            onClick={() =>
              void confirmThen(t('campaign.pause'), String(campaign.name ?? ''), 'pause')
            }
          />
        ) : null}
        {canManage && status === 'PAUSED' ? (
          <ActionButton
            label={t('campaign.resume')}
            busy={busy}
            onClick={() =>
              void confirmThen(t('campaign.resume'), String(campaign.name ?? ''), 'resume')
            }
          />
        ) : null}
        {canManage &&
        status !== 'COMPLETED' &&
        status !== 'CANCELLED' &&
        status !== 'FAILED' ? (
          <ActionButton
            label={t('campaign.cancel')}
            tone="danger"
            busy={busy}
            onClick={() =>
              void confirmThen(
                t('campaign.cancel'),
                t('campaign.cancelSubtitle'),
                'cancel',
                'danger',
              )
            }
          />
        ) : null}
      </div>

      {error === null ? null : <Banner tone="danger">{error}</Banner>}

      {canManage && status === 'READY' && preflight === null && error === null ? (
        <Banner>{t('campaign.launchNeedsPreflight')}</Banner>
      ) : null}

      {campaign.statusReason === null || campaign.statusReason === undefined ? null : (
        <Banner>
          {t('campaign.reason')}: {String(campaign.statusReason)}
        </Banner>
      )}

      {campaign.pacingObserved === true ? (
        <Banner>{t('campaign.pacing')}</Banner>
      ) : null}

      <Card title={t('campaign.numbers')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: theme.spacing[4] }}>
          {COUNTERS.map((key) => (
            <div key={key} style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={label}>{t(`campaign.counter.${key}`)}</span>
              <span style={{ fontSize: theme.font.size.lg, color: theme.font.color.primary }}>
                {Number(campaign[key] ?? 0)}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={label}>{t('campaign.counter.actualCost')}</span>
            <span style={{ fontSize: theme.font.size.lg, color: theme.font.color.primary }}>
              ${Number(campaign.actualCostUsd ?? 0).toFixed(2)}
            </span>
          </div>
        </div>
      </Card>

      {preflight === null ? null : (
        <>
          <Card title={t('campaign.preflightAudience')}>
            <div style={{ display: 'flex', gap: theme.spacing[4], flexWrap: 'wrap' }}>
              <div>
                <span style={label}>{t('campaign.willReceive')}</span>
                <div style={{ fontSize: theme.font.size.lg }}>
                  {preflight.recipients.total}
                </div>
              </div>
              <div>
                <span style={label}>{t('campaign.excluded')}</span>
                <div style={{ fontSize: theme.font.size.lg }}>
                  {preflight.recipients.excluded}
                </div>
              </div>
            </div>

            {Object.entries(preflight.recipients.breakdown)
              .filter(([, count]) => count > 0)
              .map(([reason, count]) => (
                <div key={reason} style={{ fontSize: theme.font.size.xs }}>
                  <span style={{ color: theme.font.color.secondary }}>
                    {t(`exclusion.${reason}`)}: {count}
                  </span>
                  <span style={{ ...label, marginLeft: theme.spacing[2] }}>
                    {(preflight.recipients.samples[reason] ?? [])
                      .slice(0, 3)
                      .map((sample) => sample.phone ?? sample.personId ?? '?')
                      .join(', ')}
                  </span>
                </div>
              ))}
          </Card>

          <Card title={t('campaign.preflightCost')}>
            <div style={{ fontSize: theme.font.size.sm }}>
              {t('campaign.perMessage', {
                total: preflight.cost.estimatedUsd.toFixed(2),
                rate: preflight.cost.ratePerMessageUsd,
              })}
            </div>
            <div style={label}>{preflight.cost.note}</div>

            {preflight.tier === null ? null : (
              <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
                {t('campaign.tierLine', {
                  tier: preflight.tier.tier,
                  used: preflight.tier.used,
                  limit: preflight.tier.limit,
                  reserve: preflight.tier.reserve,
                  available: preflight.tier.available,
                })}
              </div>
            )}

            {/*
              The spread is the number that turns "your audience is bigger than
              your daily allowance" from a surprise two days in into a sentence
              read before launch (R-10).
            */}
            {preflight.tier === null || preflight.tier.spread.days === null ? null : (
              <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
                {preflight.tier.spread.days <= 1
                  ? t('campaign.spreadFits')
                  : t('campaign.spreadDays', {
                      firstDay: preflight.tier.spread.firstDay,
                      days: preflight.tier.spread.days,
                    })}
              </div>
            )}
          </Card>

          <Card title={t('campaign.preflightQuality')}>
            <div style={{ fontSize: theme.font.size.xs }}>
              {t('campaign.quality')}: {preflight.quality.rating}
              {preflight.quality.gate.allowed ? '' : ` — ${preflight.quality.gate.reason ?? ''}`}
            </div>

            {preflight.quality.gate.allowed || !canManage ? null : (
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
                  checked={acknowledgeQuality}
                  onChange={(event) => setAcknowledgeQuality(event.target.checked)}
                />
                {t('campaign.acknowledge')}
              </label>
            )}

            {acknowledgeQuality && status === 'READY' ? (
              <ActionButton
                label={t('campaign.launchAnyway')}
                tone="danger"
                busy={busy}
                onClick={() => void run('launch', { acknowledgeQuality: true })}
              />
            ) : null}

            {preflight.template === null ? null : (
              <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
                {preflight.template.name} ({preflight.template.language}) ·{' '}
                {preflight.template.category}
                {preflight.template.refusal === null
                  ? ''
                  : ` — ${preflight.template.refusal}`}
              </div>
            )}
          </Card>

          {preflight.preview.length === 0 ? null : (
            <Card title={t('campaign.preflightPreview')}>
              <div
                style={{
                  border: `1px dashed ${theme.border.color.medium}`,
                  borderRadius: theme.border.radius.sm,
                  padding: theme.spacing[2],
                  fontSize: theme.font.size.sm,
                  whiteSpace: 'pre-wrap',
                  color: theme.font.color.secondary,
                }}
              >
                {preflight.preview[0].rendered.header === null ? null : (
                  <div style={{ fontWeight: theme.font.weight.semiBold }}>
                    {preflight.preview[0].rendered.header}
                  </div>
                )}
                <div>{preflight.preview[0].rendered.body}</div>
                {preflight.preview[0].rendered.footer === null ? null : (
                  <div style={label}>{preflight.preview[0].rendered.footer}</div>
                )}
              </div>
            </Card>
          )}

          {canManage && status === 'READY' ? (
            <ActionButton
              label={t('campaign.testSend')}
              busy={busy}
              onClick={() => void run('testSend')}
            />
          ) : null}
        </>
      )}

      <Card title={t('campaign.recipientsSample', { count: recipients.length })}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: theme.font.size.xs, width: '100%' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: theme.font.color.tertiary }}>
                <th style={{ padding: theme.spacing[1] }}>{t('campaign.col.phone')}</th>
                <th style={{ padding: theme.spacing[1] }}>{t('campaign.col.status')}</th>
                <th style={{ padding: theme.spacing[1] }}>{t('campaign.col.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((recipient) => (
                <tr key={String(recipient.id)}>
                  <td
                    style={{
                      padding: theme.spacing[1],
                      borderTop: `1px solid ${theme.border.color.light}`,
                    }}
                  >
                    {recipient.resolvedPhone ?? '—'}
                  </td>
                  <td
                    style={{
                      padding: theme.spacing[1],
                      borderTop: `1px solid ${theme.border.color.light}`,
                    }}
                  >
                    {recipient.status ?? '—'}
                  </td>
                  <td
                    style={{
                      padding: theme.spacing[1],
                      borderTop: `1px solid ${theme.border.color.light}`,
                      color: theme.font.color.tertiary,
                    }}
                  >
                    {recipient.exclusionReason === null ||
                    recipient.exclusionReason === undefined
                      ? (recipient.errorCode ?? '')
                      : t(`exclusion.${String(recipient.exclusionReason)}`)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};
