import 'twenty-ui/style.css';
import { useRef } from 'react';
import { Tag } from 'twenty-ui/data-display';
import { Button } from 'twenty-ui/input';
import { useTheme } from 'twenty-ui/theme-constants';

/**
 * The handful of primitives the campaigns and settings surfaces both need.
 *
 * Not a design system — `twenty-ui` is that, and wherever it has the component
 * (`Button`, `Tag`) these are thin wrappers over it, so buttons and statuses
 * are the real Twenty ones at the real Twenty scale. What stays hand-rolled is
 * only what the sandbox forces: no portals, so no popovers; no observers, so no
 * auto-sizing; no `.focus()`, so no focus-trapped modals. What is left is
 * honest inline layout, and it may as well be written once.
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
                fontSize: theme.font.size.md,
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

  /**
   * `sm` label over an `md` control, matching the label-over-input rhythm of
   * Twenty's own settings forms. `xxs` was measured at ~8px in the rendered
   * page — legible to nobody — so nothing interactive or required wears it.
   */
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
      <span
        style={{
          fontSize: theme.font.size.sm,
          fontWeight: theme.font.weight.medium,
          color: theme.font.color.light,
        }}
      >
        {label}
      </span>
      {children}
      {hint === undefined ? null : (
        <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
          {hint}
        </span>
      )}
    </label>
  );
};

export const useInputStyle = (): React.CSSProperties => {
  const theme = useTheme();

  /**
   * 32px min-height and `md` text: the same box Twenty draws for its own App
   * URL input on the settings page these forms sit under. `minHeight` rather
   * than `height` so a `<textarea rows={4}>` sharing the style keeps its rows.
   */
  return {
    border: `1px solid ${theme.border.color.medium}`,
    borderRadius: theme.border.radius.sm,
    background: theme.background.primary,
    color: theme.font.color.primary,
    fontFamily: theme.font.family,
    fontSize: theme.font.size.md,
    padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
    minHeight: '32px',
    boxSizing: 'border-box',
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

/**
 * Twenty's own `Button`, with this app's three tones mapped onto its
 * variant/accent axes. Wrapping rather than importing it at every call site
 * keeps the old `tone`/`busy` API the surfaces already speak.
 */
export const ActionButton = ({
  label,
  onClick,
  disabled = false,
  tone = 'default',
  busy = false,
}: ActionButtonProps) => (
  <Button
    title={label}
    ariaLabel={label}
    onClick={onClick}
    disabled={disabled || busy}
    isLoading={busy}
    variant={tone === 'primary' ? 'primary' : 'secondary'}
    accent={tone === 'primary' ? 'blue' : tone === 'danger' ? 'danger' : 'default'}
    size="medium"
  />
);

/**
 * Twenty's `Tag`, so statuses read at the scale and shape of every other
 * status in the workspace. Never colour alone: the tag always carries its own
 * word, so a reader who cannot tell amber from green still reads "PAUSED".
 */
export const StatusPill = ({ status }: { status: string | null }) => (
  <Tag
    color={
      status === 'RUNNING' || status === 'COMPLETED'
        ? 'green'
        : status === 'FAILED' || status === 'CANCELLED'
          ? 'red'
          : 'gray'
    }
    text={status ?? '—'}
    weight="medium"
  />
);

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
        padding: theme.spacing[2],
        borderRadius: theme.border.radius.sm,
        fontSize: theme.font.size.md,
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

/** The id a `<TabPanel>` must carry so its tab can point at it. */
export const tabPanelId = (group: string, key: string): string => `wa-tab-${group}-${key}`;

const tabId = (group: string, key: string): string => `wa-tabbtn-${group}-${key}`;

/**
 * Which tab an arrow key moves to.
 *
 * Exported because it is the whole of the keyboard model and the only part
 * worth testing: wrapping at both ends is what stops Home/End being the only
 * way out of the last tab.
 */
export const nextTabKey = (
  keys: string[],
  active: string,
  press: string,
): string | null => {
  if (keys.length === 0) return null;

  const at = keys.indexOf(active);
  const from = at === -1 ? 0 : at;

  switch (press) {
    case 'ArrowRight':
    case 'ArrowDown':
      return keys[(from + 1) % keys.length] ?? null;
    case 'ArrowLeft':
    case 'ArrowUp':
      return keys[(from - 1 + keys.length) % keys.length] ?? null;
    case 'Home':
      return keys[0] ?? null;
    case 'End':
      return keys[keys.length - 1] ?? null;
    default:
      return null;
  }
};

/**
 * A WAI-ARIA tab list.
 *
 * It carried `role="tab"` and `aria-selected` without the behaviour those roles
 * promise, which is worse than plain buttons: a screen reader announces "tab,
 * 2 of 4" and then the arrow keys do nothing. What was missing is here —
 * roving `tabIndex` so the list is one stop rather than four, arrow/Home/End
 * navigation, and `aria-controls` pointing at a real `tabpanel`.
 *
 * `group` namespaces the generated ids: two tab lists on one page (the app
 * settings screen has Twenty's own above ours) must not both claim
 * `wa-tab-health`.
 */
export const Tabs = ({
  tabs,
  active,
  onSelect,
  group = 'wa',
  label,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onSelect: (key: string) => void;
  group?: string;
  label?: string;
}) => {
  const theme = useTheme();
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        const next = nextTabKey(
          tabs.map((tab) => tab.key),
          active,
          event.key,
        );

        if (next === null) return;

        // Arrow keys inside a tab list must not also scroll the page.
        event.preventDefault();
        onSelect(next);

        /**
         * Focus should follow selection under automatic activation, or a screen
         * reader keeps announcing the tab the user just left.
         *
         * **It does not move here, and that is measured, not assumed.** The
         * call is made and does not throw; `document.activeElement` simply
         * stays where it was, so the sandbox accepts `.focus()` and ignores it
         * (D-53). The call stays because it costs nothing and will start
         * working the day the platform implements it, and because the
         * alternative — pretending the strip is manually activated — would need
         * the same missing capability.
         */
        try {
          buttons.current.get(next)?.focus();
        } catch {
          // Keyboard selection still works; only the announcement lags.
        }
      }}
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
          ref={(node) => {
            if (node === null) buttons.current.delete(tab.key);
            else buttons.current.set(tab.key, node);
          }}
          id={tabId(group, tab.key)}
          aria-selected={active === tab.key}
          aria-controls={tabPanelId(group, tab.key)}
          /**
           * Roving: only the selected tab is tabbable, so Tab enters the list
           * once and leaves once. Focus follows selection, which is the
           * automatic-activation pattern — correct here because every panel is
           * already loaded or loads on demand from the same state.
           */
          tabIndex={active === tab.key ? 0 : -1}
          onClick={() => onSelect(tab.key)}
          /**
           * Styled to `twenty-ui`'s `TabButton` scale (`md` text, 2px active
           * underline) rather than replaced by it: `TabButton` accepts no
           * `role`, `aria-*`, or ref, and swapping it in would silently drop
           * the roving-tabindex tab list built above.
           */
          style={{
            border: 'none',
            borderBottom: `2px solid ${
              active === tab.key ? theme.border.color.strong : 'transparent'
            }`,
            background: 'transparent',
            color: active === tab.key ? theme.font.color.primary : theme.font.color.tertiary,
            cursor: 'pointer',
            fontFamily: theme.font.family,
            fontSize: theme.font.size.md,
            fontWeight: theme.font.weight.medium,
            padding: `${theme.spacing[2]} ${theme.spacing[2]}`,
            whiteSpace: 'nowrap',
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
};

/**
 * The other half of the pair. A `role="tab"` whose `aria-controls` points at
 * nothing is a promise the markup does not keep.
 */
export const TabPanel = ({
  group = 'wa',
  tabKey,
  children,
}: {
  group?: string;
  tabKey: string;
  children: React.ReactNode;
}) => (
  <div
    role="tabpanel"
    id={tabPanelId(group, tabKey)}
    aria-labelledby={`wa-tabbtn-${group}-${tabKey}`}
    tabIndex={0}
    style={{ display: 'flex', flexDirection: 'column', gap: 'inherit', outline: 'none' }}
  >
    {children}
  </div>
);
