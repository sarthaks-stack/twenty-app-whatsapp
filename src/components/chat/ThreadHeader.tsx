import { useTheme } from 'twenty-ui/theme-constants';

import type { AccountProjection, ThreadProjection } from '../../domain/feed/projection';
import type { Translate } from '../common/copy';
import { countdown, displayPhone } from '../common/format';

/**
 * Who this conversation is with, and what state it is in (specs/08 §3, FR-UI-6).
 *
 * The window chip is the one element a rep is expected to read before typing,
 * so it says the same thing three ways — colour, icon and words — and the
 * countdown is truncated rather than rounded (`format.countdown`), because a
 * window with fifty seconds left must not read "1m".
 */

export type ThreadHeaderProps = {
  thread: ThreadProjection;
  account: AccountProjection | null;
  t: Translate;
  now: Date;
  onToggleBlock?: () => void;
  onClose?: () => void;
};

export const WindowChip = ({
  thread,
  t,
  now,
}: {
  thread: ThreadProjection;
  t: Translate;
  now: Date;
}) => {
  const theme = useTheme();
  const remaining = countdown(thread.serviceWindowExpiresAt, now);
  const open = remaining !== null;

  return (
    <div
      className="wa-window-chip"
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.spacing[1],
        fontSize: theme.font.size.xs,
        color: open ? theme.font.color.secondary : theme.font.color.tertiary,
        background: open
          ? theme.background.transparent.success
          : theme.background.transparent.light,
        borderRadius: theme.border.radius.pill,
        padding: `${theme.spacing[0.5]} ${theme.spacing[2]}`,
      }}
    >
      <span aria-hidden="true">{open ? '🟢' : '🔒'}</span>
      <span>
        {open
          ? `${t('chat.windowOpen')} — ${t('chat.closesIn', { time: remaining })}`
          : t('chat.windowClosed')}
      </span>
    </div>
  );
};

const Chip = ({ children, tone }: { children: React.ReactNode; tone?: 'danger' }) => {
  const theme = useTheme();

  return (
    <span
      style={{
        fontSize: theme.font.size.xxs,
        color: tone === 'danger' ? theme.font.color.danger : theme.font.color.secondary,
        background:
          tone === 'danger'
            ? theme.background.transparent.danger
            : theme.background.transparent.light,
        borderRadius: theme.border.radius.sm,
        padding: `0 ${theme.spacing[1]}`,
      }}
    >
      {children}
    </span>
  );
};

export const ThreadHeader = ({
  thread,
  account,
  t,
  now,
  onToggleBlock,
  onClose,
}: ThreadHeaderProps) => {
  const theme = useTheme();

  const name =
    thread.person === null
      ? (thread.profileName ?? displayPhone(thread.dialablePhone))
      : [thread.person.firstName, thread.person.lastName].filter(Boolean).join(' ') ||
        (thread.profileName ?? '');

  const consent = thread.person?.whatsappOptInStatus ?? 'UNKNOWN';

  return (
    <div
      className="wa-thread-header"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[1],
        padding: theme.spacing[2],
        borderBottom: `1px solid ${theme.border.color.light}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[2],
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontWeight: theme.font.weight.semiBold,
            fontSize: theme.font.size.sm,
            color: theme.font.color.primary,
          }}
        >
          {name === '' ? displayPhone(thread.waId) : name}
        </span>
        <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
          {displayPhone(thread.dialablePhone ?? thread.waId)}
        </span>

        {thread.status === 'NEEDS_REVIEW' ? <Chip>{t('chat.needsReview')}</Chip> : null}
        {thread.isBlocked ? <Chip tone="danger">{t('chat.blocked')}</Chip> : null}
        <Chip>{t(`consent.${consent}`)}</Chip>
        {account?.isTestAccount === true ? <Chip>{t('chat.testAccount')}</Chip> : null}
        {account?.qualityRating === 'YELLOW' ? <Chip>{t('chat.qualityYellow')}</Chip> : null}
        {account?.qualityRating === 'RED' ? (
          <Chip tone="danger">{t('chat.qualityRed')}</Chip>
        ) : null}

        <span style={{ flex: '1 1 auto' }} />

        {onToggleBlock === undefined ? null : (
          <button
            type="button"
            onClick={onToggleBlock}
            aria-label={t(thread.isBlocked ? 'chat.unblock' : 'chat.block')}
            style={{
              border: `1px solid ${theme.border.color.medium}`,
              background: 'transparent',
              borderRadius: theme.border.radius.sm,
              color: theme.font.color.secondary,
              cursor: 'pointer',
              fontSize: theme.font.size.xxs,
              padding: `0 ${theme.spacing[1]}`,
            }}
          >
            {t(thread.isBlocked ? 'chat.unblock' : 'chat.block')}
          </button>
        )}

        {onClose === undefined ? null : (
          <button
            type="button"
            onClick={onClose}
            aria-label={t(thread.status === 'CLOSED' ? 'chat.reopen' : 'chat.close')}
            style={{
              border: `1px solid ${theme.border.color.medium}`,
              background: 'transparent',
              borderRadius: theme.border.radius.sm,
              color: theme.font.color.secondary,
              cursor: 'pointer',
              fontSize: theme.font.size.xxs,
              padding: `0 ${theme.spacing[1]}`,
            }}
          >
            {t(thread.status === 'CLOSED' ? 'chat.reopen' : 'chat.close')}
          </button>
        )}
      </div>

      <WindowChip thread={thread} t={t} now={now} />

      {account !== null && account.status !== 'CONNECTED' ? (
        <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.danger }}>
          ⚠ {t('chat.accountError')}
        </div>
      ) : null}
    </div>
  );
};
