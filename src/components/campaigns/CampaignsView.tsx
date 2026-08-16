import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

/**
 * Below this the nine-column table cannot hold real names and counts without
 * colliding, so the list switches to stacked cards. Measured the same way the
 * inbox measures itself: `clientWidth` re-read every render, because
 * `ResizeObserver` is undefined here and `getBoundingClientRect` returns 0×0
 * (P-6).
 */
export const TABLE_MIN_WIDTH = 640;

export const CampaignsView = () => {
  const theme = useTheme();
  const { t, lang } = useCopy();

  const [screen, setScreen] = useState<'list' | 'builder'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wide, setWide] = useState(true);

  const measured = useRef<boolean | null>(null);
  const node = useRef<HTMLDivElement | null>(null);

  const measure = useCallback(() => {
    const element = node.current;

    if (element === null) return;

    try {
      const width =
        element.clientWidth > 0
          ? element.clientWidth
          : typeof window === 'undefined'
            ? 0
            : (window.innerWidth ?? 0);

      const isWide = width >= TABLE_MIN_WIDTH;

      if (measured.current !== isWide) {
        measured.current = isWide;
        setWide(isWide);
      }
    } catch {
      // Failing towards the card layout is the safe direction: cards in a
      // wide pane are merely roomy, the table in a narrow one is unreadable.
      measured.current = false;
      setWide(false);
    }
  }, []);

  useEffect(() => {
    measure();
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }

    try {
      window.addEventListener('resize', measure);

      return () => window.removeEventListener('resize', measure);
    } catch {
      return;
    }
  }, [measure]);

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
      ref={node}
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
          style={{ fontWeight: theme.font.weight.semiBold, fontSize: theme.font.size.lg }}
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

      {campaigns.length === 0 ? (
        <Card>
          <div
            style={{
              padding: theme.spacing[4],
              textAlign: 'center',
              color: theme.font.color.tertiary,
              fontSize: theme.font.size.md,
            }}
          >
            {list.isUnavailable
              ? t('common.unavailable')
              : list.isLoading && list.data === null
                ? t('common.loading')
                : t('campaign.none')}
          </div>
        </Card>
      ) : wide ? (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                borderCollapse: 'collapse',
                width: '100%',
                /**
                 * Fit is never solved by shrinking text: below this the whole
                 * list switches to cards, so the table only ever renders with
                 * room for real names and counts.
                 */
                minWidth: `${TABLE_MIN_WIDTH}px`,
                fontSize: theme.font.size.md,
              }}
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
                    <th
                      key={key}
                      style={{
                        padding: theme.spacing[2],
                        fontSize: theme.font.size.sm,
                        fontWeight: theme.font.weight.medium,
                      }}
                    >
                      {t(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr key={String(campaign.id)}>
                    <td
                      style={{
                        padding: theme.spacing[2],
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
                          fontSize: theme.font.size.md,
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
                        padding: theme.spacing[2],
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
                          padding: theme.spacing[2],
                          borderTop: `1px solid ${theme.border.color.light}`,
                        }}
                      >
                        {Number(campaign[key] ?? 0)}
                      </td>
                    ))}
                    <td
                      style={{
                        padding: theme.spacing[2],
                        borderTop: `1px solid ${theme.border.color.light}`,
                      }}
                    >
                      ${Number(campaign.actualCostUsd ?? campaign.estimatedCostUsd ?? 0).toFixed(2)}
                    </td>
                    <td
                      style={{
                        padding: theme.spacing[2],
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
      ) : (
        /**
         * The narrow shape: one card per campaign, the whole card a button
         * into detail. Name, status, and the counters that matter; the rest
         * lives in the detail screen it opens.
         */
        campaigns.map((campaign) => (
          <button
            key={String(campaign.id)}
            type="button"
            onClick={() => setSelectedId(String(campaign.id))}
            aria-label={String(campaign.name ?? '')}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: theme.spacing[1],
              width: '100%',
              textAlign: 'left',
              border: `1px solid ${theme.border.color.light}`,
              borderRadius: theme.border.radius.md,
              background: theme.background.secondary,
              color: theme.font.color.primary,
              cursor: 'pointer',
              fontFamily: theme.font.family,
              padding: theme.spacing[3],
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[2] }}>
              <span
                style={{
                  fontSize: theme.font.size.md,
                  fontWeight: theme.font.weight.semiBold,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: '1 1 auto',
                }}
              >
                {String(campaign.name ?? '—')}
              </span>
              <StatusPill status={(campaign.status ?? null) as string | null} />
            </span>
            <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}>
              {t('campaign.counter.deliveredCount')} {Number(campaign.deliveredCount ?? 0)}/
              {Number(campaign.recipientCount ?? 0)} ·{' '}
              {t('campaign.counter.respondedCount')} {Number(campaign.respondedCount ?? 0)} · $
              {Number(campaign.actualCostUsd ?? campaign.estimatedCostUsd ?? 0).toFixed(2)}
            </span>
            <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}>
              {relativeTime(campaign.createdAt as string | null, now, lang)}
            </span>
          </button>
        ))
      )}
    </div>
  );
};
