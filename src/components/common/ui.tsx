import { useTheme } from 'twenty-ui/theme-constants';

/**
 * The handful of primitives the campaigns and settings surfaces both need.
 *
 * Not a design system — `twenty-ui` is that, and every colour below comes from
 * `useTheme()`. These exist because a `<select>` styled seven times in two files
 * drifts, and because the sandbox forbids the usual escape hatches: no portals,
 * so no popovers; no observers, so no auto-sizing; no `.focus()`, so no
 * focus-trapped modals. What is left is honest inline layout, and it may as well
 * be written once.
 */

export const Card = ({
  title,
  children,
  actions,
}: {
  title?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) => {
  const theme = useTheme();

  return (
    <section
      className="wa-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        border: `1px solid ${theme.border.color.light}`,
        borderRadius: theme.border.radius.md,
        background: theme.background.secondary,
        padding: theme.spacing[3],
      }}
    >
      {title === undefined && actions === undefined ? null : (
        <header style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[2] }}>
          {title === undefined ? null : (
            <h3
              style={{
                margin: 0,
                fontSize: theme.font.size.sm,
                fontWeight: theme.font.weight.semiBold,
                color: theme.font.color.primary,
              }}
            >
              {title}
            </h3>
          )}
          <span style={{ flex: '1 1 auto' }} />
          {actions}
        </header>
      )}
      {children}
    </section>
  );
};

export const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) => {
  const theme = useTheme();

  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
      <span style={{ fontSize: theme.font.size.xxs, color: theme.font.color.tertiary }}>
        {label}
      </span>
      {children}
      {hint === undefined ? null : (
        <span style={{ fontSize: theme.font.size.xxs, color: theme.font.color.tertiary }}>
          {hint}
        </span>
      )}
    </label>
  );
};

export const useInputStyle = (): React.CSSProperties => {
  const theme = useTheme();

  return {
    border: `1px solid ${theme.border.color.medium}`,
    borderRadius: theme.border.radius.sm,
    background: theme.background.primary,
    color: theme.font.color.primary,
    fontFamily: theme.font.family,
    fontSize: theme.font.size.sm,
    padding: theme.spacing[1],
    width: '100%',
  };
};

export type ActionButtonProps = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'default' | 'danger';
  busy?: boolean;
};

export const ActionButton = ({
  label,
  onClick,
  disabled = false,
  tone = 'default',
  busy = false,
}: ActionButtonProps) => {
  const theme = useTheme();

  const background =
    disabled || busy
      ? theme.background.transparent.light
      : tone === 'primary'
        ? theme.color.blue
        : tone === 'danger'
          ? theme.background.transparent.danger
          : 'transparent';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={label}
      aria-busy={busy}
      style={{
        border:
          tone === 'primary' && !disabled && !busy
            ? 'none'
            : `1px solid ${
                tone === 'danger' ? theme.border.color.danger : theme.border.color.medium
              }`,
        borderRadius: theme.border.radius.sm,
        background,
        color:
          disabled || busy
            ? theme.font.color.tertiary
            : tone === 'primary'
              ? theme.font.color.inverted
              : tone === 'danger'
                ? theme.font.color.danger
                : theme.font.color.secondary,
        cursor: disabled || busy ? 'default' : 'pointer',
        fontFamily: theme.font.family,
        fontSize: theme.font.size.xs,
        padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
};

export const StatusPill = ({ status }: { status: string | null }) => {
  const theme = useTheme();

  /**
   * Status is never colour alone: the pill always carries its own word. A
   * reader who cannot tell amber from green still reads "PAUSED".
   */
  const tone =
    status === 'RUNNING' || status === 'COMPLETED'
      ? theme.background.transparent.success
      : status === 'FAILED' || status === 'CANCELLED'
        ? theme.background.transparent.danger
        : theme.background.transparent.light;

  return (
    <span
      style={{
        fontSize: theme.font.size.xxs,
        background: tone,
        color: theme.font.color.secondary,
        borderRadius: theme.border.radius.pill,
        padding: `0 ${theme.spacing[2]}`,
        whiteSpace: 'nowrap',
      }}
    >
      {status ?? '—'}
    </span>
  );
};

export const Banner = ({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'danger' | 'success';
  children: React.ReactNode;
}) => {
  const theme = useTheme();

  return (
    <div
      role="status"
      style={{
        padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
        borderRadius: theme.border.radius.sm,
        fontSize: theme.font.size.xs,
        background:
          tone === 'danger'
            ? theme.background.transparent.danger
            : tone === 'success'
              ? theme.background.transparent.success
              : theme.background.transparent.light,
        color: tone === 'danger' ? theme.font.color.danger : theme.font.color.secondary,
      }}
    >
      {children}
    </div>
  );
};

export const Tabs = ({
  tabs,
  active,
  onSelect,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onSelect: (key: string) => void;
}) => {
  const theme = useTheme();

  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        gap: theme.spacing[1],
        overflowX: 'auto',
        borderBottom: `1px solid ${theme.border.color.light}`,
        padding: theme.spacing[1],
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          onClick={() => onSelect(tab.key)}
          style={{
            border: 'none',
            borderBottom: `2px solid ${
              active === tab.key ? theme.border.color.strong : 'transparent'
            }`,
            background: 'transparent',
            color: active === tab.key ? theme.font.color.primary : theme.font.color.tertiary,
            cursor: 'pointer',
            fontFamily: theme.font.family,
            fontSize: theme.font.size.xs,
            padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
            whiteSpace: 'nowrap',
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
};
