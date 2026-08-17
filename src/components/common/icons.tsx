import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArchive,
  IconArrowLeft,
  IconBroadcast,
  IconCalendarTime,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconCurrencyDollar,
  IconDotsVertical,
  IconDownload,
  IconEdit,
  IconFileText,
  IconFilter,
  IconFlask,
  IconForbid,
  IconHelpCircle,
  IconHourglassHigh,
  IconInbox,
  IconList,
  IconLock,
  IconMessage,
  IconPaperclip,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSend,
  IconSettings,
  IconUser,
  IconUserPlus,
  IconUsers,
  IconX,
  type IconComponent,
} from 'twenty-ui/icon';
import { useTheme } from 'twenty-ui/theme-constants';

/**
 * One place that decides which picture means which thing.
 *
 * Every icon here is exported by `twenty-ui/icon` — the same Tabler set the rest
 * of the workspace draws from — so a status in this app looks like a status in
 * Twenty rather than like an emoji somebody's font substituted. That is the
 * whole reason for the file: the glyphs it replaces (`🟢`, `📣`, `⋯`, `✓✓`)
 * rendered at whatever size and colour the platform's emoji font felt like, and
 * two of them were the *only* thing distinguishing two states.
 *
 * **An icon is never the whole message.** Everything in the map below appears
 * beside its own word, or carries an `aria-label` when the word is genuinely
 * redundant (a send button labelled "Send"). Colour and shape are the third and
 * fourth ways of saying something, never the first.
 */

export const ICON = {
  // Inbox filters
  mine: IconUser,
  unassigned: IconUserPlus,
  all: IconList,
  campaign_replies: IconBroadcast,
  window_expiring: IconClock,
  closed: IconArchive,

  // Inbox toolbar
  search: IconSearch,
  filter: IconFilter,
  inbox: IconInbox,

  // Thread and message state
  needsReview: IconAlertCircle,
  windowOpen: IconClock,
  windowClosed: IconLock,
  blocked: IconForbid,
  optedIn: IconCheck,
  optedOut: IconForbid,
  consentUnknown: IconHelpCircle,
  testAccount: IconFlask,
  warning: IconAlertTriangle,

  // Message actions and adornments
  send: IconSend,
  template: IconFileText,
  attachment: IconPaperclip,
  more: IconDotsVertical,
  download: IconDownload,
  retry: IconRefresh,
  dismiss: IconX,
  back: IconArrowLeft,
  chevron: IconChevronRight,
  settings: IconSettings,

  // Campaigns
  newCampaign: IconPlus,
  draft: IconEdit,
  scheduled: IconCalendarTime,
  running: IconPlayerPlay,
  paused: IconPlayerPause,
  completed: IconCheck,
  failed: IconAlertTriangle,
  audience: IconUsers,
  replies: IconMessage,
  cost: IconCurrencyDollar,
  pending: IconHourglassHigh,
} as const satisfies Record<string, IconComponent>;

export type IconName = keyof typeof ICON;

/**
 * The delivery ticks, as icons rather than as `✓✓`.
 *
 * Kept as a component instead of a map entry because a double tick is two
 * overlapping glyphs and there is no Tabler icon for it. The overlap is drawn
 * here, once, so the read state looks like WhatsApp's familiar pair without
 * every bubble reinventing the offset — and the pair is decorative in the
 * accessibility tree, because the bubble already carries the state in words.
 */
export const DeliveryTicks = ({
  status,
  color,
}: {
  status: string | null;
  color: string;
}) => {
  const theme = useTheme();
  const size = theme.icon.size.sm;

  if (status === 'FAILED') {
    return <IconAlertTriangle size={size} stroke={theme.icon.stroke.md} color={color} />;
  }

  if (status === 'QUEUED' || status === null) {
    return <IconClock size={size} stroke={theme.icon.stroke.sm} color={color} />;
  }

  const double =
    status === 'DELIVERED' || status === 'READ' || status === 'PLAYED';

  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        // The second tick sits a third of a glyph behind the first, which is
        // the offset that reads as one mark rather than as two ticks.
        width: double ? `${size * 1.35}px` : `${size}px`,
        height: `${size}px`,
        position: 'relative',
      }}
    >
      <IconCheck
        size={size}
        stroke={theme.icon.stroke.md}
        color={color}
        style={{ position: 'absolute', left: 0 }}
      />
      {double ? (
        <IconCheck
          size={size}
          stroke={theme.icon.stroke.md}
          color={color}
          style={{ position: 'absolute', left: `${size * 0.35}px` }}
        />
      ) : null}
    </span>
  );
};

/**
 * An icon at the size the surrounding text expects.
 *
 * `sm` for anything inside a tag or a metadata line, `md` for a button. The
 * review measured icons at 14–16px in tags and 16–18px in buttons; those are
 * `theme.icon.size.sm` and `theme.icon.size.md`, so the sizes come from the
 * theme rather than from a number typed at the call site.
 */
export const Glyph = ({
  name,
  size = 'sm',
  color,
  label,
}: {
  name: IconName;
  size?: 'sm' | 'md';
  color?: string;
  /** Omit for decoration beside a word; supply when the icon stands alone. */
  label?: string;
}) => {
  const theme = useTheme();
  const Component = ICON[name];

  return (
    <span
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', flex: '0 0 auto' }}
    >
      <Component
        size={size === 'sm' ? theme.icon.size.sm : theme.icon.size.md}
        stroke={theme.icon.stroke.sm}
        color={color ?? 'currentColor'}
      />
    </span>
  );
};
