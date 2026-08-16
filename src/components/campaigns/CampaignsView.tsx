import { useMemo, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import { useCopy } from '../common/copy';
import { relativeTime } from '../common/format';
import { ActionButton, Banner, Card, StatusPill } from '../common/ui';
import { useFeed } from '../common/use-feed';
import { CampaignBuilder } from './CampaignBuilder';
import { CampaignDetail } from './CampaignDetail';

/**
 * The campaigns page (FR-CAM-10, specs/08 §5).
 *
 * Three screens behind one feed: the list, the builder, and one campaign's
 * detail. They share a poll rather than each opening their own, and the
 * interval tightens only while something is actually running — a page of
 * finished campaigns asking every ten seconds whether they are still finished
 * is exactly the budget D-6 exists to protect.
 */

const RUNNING = new Set(['RUNNING', 'SNAPSHOTTING', 'TIER_WAITING', 'SCHEDULED']);

export const CampaignsView = () => {
  const theme = useTheme();
  const { t, lang } = useCopy();

  const [screen, setScreen] = useState<'list' | 'builder'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useFeed({ scope: 'campaign', intervalMs: 10_000 });
  const detail = useFeed({
    scope: 'campaign',
    id: selectedId,
    enabled: selectedId !== null,
    intervalMs: 5_000,
  });

  const bootstrap = useFeed({ scope: 'bootstrap', intervalMs: 300_000 });

  const campaigns = (list.data?.campaigns ?? []) as Record<string, any>[];
  const canManage = list.data?.permissions.canManageCampaigns === true;
  const now = new Date(list.data?.serverTime ?? Date.now());

  const anyRunning = useMemo(
    () => campaigns.some((campaign) => RUNNING.has(String(campaign.status))),
    [campaigns],
  );

  if (screen === 'builder') {
    return (
      <div
        {...list.rootProps}
        style={{
          padding: theme.spacing[3],
          overflowY: 'auto',
          height: '100%',
          background: theme.background.primary,
          color: theme.font.color.primary,
          fontFamily: theme.font.family,
        }}
      >
        <CampaignBuilder
          accounts={bootstrap.data?.accounts ?? []}
          templates={bootstrap.data?.templates ?? []}
          onCancel={() => setScreen('list')}
          onDone={(campaignId) => {
            setSelectedId(campaignId);
            setScreen('list');
            list.refresh();
          }}
        />
      </div>
    );
  }

  if (selectedId !== null) {
    const campaign = (detail.data?.campaign ?? null) as Record<string, any> | null;

    return (
      <div
        {...detail.rootProps}
        style={{
          padding: theme.spacing[3],
          overflowY: 'auto',
          height: '100%',
          background: theme.background.primary,
          color: theme.font.color.primary,
          fontFamily: theme.font.family,
        }}
      >
        {campaign === null ? (
          <Banner>{t('common.loading')}</Banner>
        ) : (
          <CampaignDetail
            campaign={campaign}
            recipients={(detail.data?.recipients ?? []) as Record<string, any>[]}
            canManage={canManage}
            t={t}
            onBack={() => setSelectedId(null)}
            onChanged={() => {
              detail.refresh();
              list.refresh();
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div
      {...list.rootProps}
      style={{
        padding: theme.spacing[3],
        overflowY: 'auto',
        height: '100%',
        background: theme.background.primary,
        color: theme.font.color.primary,
        fontFamily: theme.font.family,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[2] }}>
        <span
          style={{ fontWeight: theme.font.weight.semiBold, fontSize: theme.font.size.md }}
        >
          {t('campaign.title')}
        </span>
        <span style={{ flex: '1 1 auto' }} />
        {canManage ? (
          <ActionButton
            label={t('campaign.new')}
            tone="primary"
            onClick={() => setScreen('builder')}
          />
        ) : null}
      </div>

      {list.isStale ? <Banner tone="danger">{t('chat.offline')}</Banner> : null}

      {/* Nothing loaded at all is a different thing from no campaigns yet. */}
      {list.isUnavailable ? (
        <Banner tone="danger">
          {t('common.unavailable')} {list.error}
        </Banner>
      ) : null}

      {anyRunning ? (
        <Banner>{t('campaign.running')}</Banner>
      ) : null}

      <Card>
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{ borderCollapse: 'collapse', width: '100%', fontSize: theme.font.size.xs }}
          >
            <thead>
              <tr style={{ textAlign: 'left', color: theme.font.color.tertiary }}>
                {[
                  'campaign.col.name',
                  'campaign.col.status',
                  'campaign.counter.recipientCount',
                  'campaign.counter.deliveredCount',
                  'campaign.counter.readCount',
                  'campaign.counter.failedCount',
                  'campaign.counter.respondedCount',
                  'campaign.counter.actualCost',
                  'campaign.col.created',
                ].map((key) => (
                  <th key={key} style={{ padding: theme.spacing[1] }}>
                    {t(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {campaigns.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    style={{
                      padding: theme.spacing[4],
                      textAlign: 'center',
                      color: theme.font.color.tertiary,
                    }}
                  >
                    {list.isUnavailable
                      ? t('common.unavailable')
                      : list.isLoading && list.data === null
                        ? t('common.loading')
                        : t('campaign.none')}
                  </td>
                </tr>
              ) : null}

              {campaigns.map((campaign) => (
                <tr key={String(campaign.id)}>
                  <td
                    style={{
                      padding: theme.spacing[1],
                      borderTop: `1px solid ${theme.border.color.light}`,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(String(campaign.id))}
                      aria-label={String(campaign.name ?? '')}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: theme.font.color.primary,
                        cursor: 'pointer',
                        fontFamily: theme.font.family,
                        fontSize: theme.font.size.xs,
                        padding: 0,
                        textAlign: 'left',
                        textDecoration: 'underline',
                      }}
                    >
                      {String(campaign.name ?? '—')}
                    </button>
                  </td>
                  <td
                    style={{
                      padding: theme.spacing[1],
                      borderTop: `1px solid ${theme.border.color.light}`,
                    }}
                  >
                    <StatusPill status={(campaign.status ?? null) as string | null} />
                  </td>
                  {(
                    [
                      'recipientCount',
                      'deliveredCount',
                      'readCount',
                      'failedCount',
                      'respondedCount',
                    ] as const
                  ).map((key) => (
                    <td
                      key={key}
                      style={{
                        padding: theme.spacing[1],
                        borderTop: `1px solid ${theme.border.color.light}`,
                      }}
                    >
                      {Number(campaign[key] ?? 0)}
                    </td>
                  ))}
                  <td
                    style={{
                      padding: theme.spacing[1],
                      borderTop: `1px solid ${theme.border.color.light}`,
                    }}
                  >
                    ${Number(campaign.actualCostUsd ?? campaign.estimatedCostUsd ?? 0).toFixed(2)}
                  </td>
                  <td
                    style={{
                      padding: theme.spacing[1],
                      borderTop: `1px solid ${theme.border.color.light}`,
                      color: theme.font.color.tertiary,
                    }}
                  >
                    {relativeTime(campaign.createdAt as string | null, now, lang)}
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
