import { useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { ContactCardProjection } from '../../domain/feed/content';
import type { PersonProjection } from '../../domain/feed/projection';
import type { QuoteProjection } from '../../domain/feed/quote';
import type { FieldError } from '../../domain/interactive/validate';
import type { ResolvedParameters } from '../../domain/template-render';
import type { Translate } from '../common/copy';
import { Glyph, type IconName } from '../common/icons';
import type { ThreadCapabilities } from '../../domain/feed/capabilities';
import type { FeedPolicy, FeedTemplate } from '../common/use-feed';
import { InteractiveBuilder } from './builders/InteractiveBuilder';
import { AttachmentPanel, ContactPanel, LocationPanel } from './builders/SendPanels';
import { VoicePanel } from './builders/VoicePanel';
import { QuoteStrip } from './QuoteStrip';
import { TemplatePicker } from './TemplatePicker';

/**
 * Where a rep works (specs/08 §3.3, FR-OUT-1, FR-OUT-2, spec §"Composer
 * redesign").
 *
 * Every state below is driven by the server's `policy` and `capabilities`. The
 * composer does not know what the 24-hour rule is and must not: the rule lives
 * in one pure module that the send route re-runs immediately before the Meta
 * call (AR-17), so a component that re-derived it would eventually enable an
 * action for a send that is about to be refused.
 *
 * `WINDOW_CLOSED` is still the interesting denial. It does not merely disable
 * the box — it *replaces* the primary action with **Escolher modelo**, because
 * a closed window is not a dead end, it is an instruction (FR-OUT-5). What is
 * new is that the ＋ menu obeys the same rule per entry: a closed window greys
 * every session action and leaves the template path lit, rather than offering
 * eight things that would all be refused.
 *
 * **One mode at a time, as a discriminated state.** The predecessor had two
 * booleans; eight would be 256 representable states, most of them nonsense —
 * an attachment panel open *over* the template picker with a recording running.
 * A single `mode` makes those unrepresentable.
 *
 * Sandbox mechanics, unchanged and still binding: the textarea is controlled
 * and never autofocused (`.focus()` throws), Enter sends and Shift+Enter breaks
 * the line, panels render inline because portals render nothing, and a refusal
 * renders inline rather than as a toast — a toast that has faded cannot be
 * re-read.
 */

export type ComposerMode =
  | { kind: 'text' }
  | { kind: 'template' }
  | { kind: 'attachment'; initial: 'image' | 'document' }
  | { kind: 'voice' }
  | { kind: 'location' }
  | { kind: 'contact' }
  | { kind: 'interactive-buttons' }
  | { kind: 'interactive-list' };

export type ComposerProps = {
  policy: FeedPolicy | undefined;
  capabilities: ThreadCapabilities | undefined;
  templates: FeedTemplate[];
  canSend: boolean;
  t: Translate;
  isSending: boolean;
  /** A `DENIAL` code from a 409, kept on screen until the rep acts. */
  refusal: string | null;
  /** Field-addressed errors from the route, routed to the open builder. */
  fieldErrors: FieldError[];
  /** The message being replied to, shown as a strip above the box. */
  replyTarget: QuoteProjection | null;
  person: PersonProjection | null;
  onSendText: (body: string) => void;
  onSendTemplate: (templateId: string, parameters: ResolvedParameters) => void;
  onSendMedia: (input: {
    mediaKind: 'image' | 'video' | 'audio' | 'document';
    fileUrl?: string;
    filePath?: string;
    filename: string | null;
    caption: string | null;
    voice?: boolean;
  }) => void;
  onSendLocation: (input: {
    latitude: number;
    longitude: number;
    name: string | null;
    address: string | null;
  }) => void;
  onSendContact: (contact: ContactCardProjection) => void;
  /**
   * Resolves to whether the route accepted it. The builder stays open on a
   * refusal, because that is the only surface its field-addressed errors have.
   */
  onSendInteractive: (interactive: Record<string, unknown>) => Promise<boolean>;
  onCancelReply: () => void;
  onDismissRefusal: () => void;
};

export const MAX_TEXT_LENGTH = 4096;

/**
 * How much of the conversation a composer panel is allowed to take.
 *
 * A template with six variables rendered a form taller than the pane, and the
 * transcript went with it — a rep filling one in could not see the message they
 * were answering, or check the name they were about to type. The cap is what
 * keeps the conversation on screen; the panel scrolls inside it.
 */
const PANEL_MAX_HEIGHT = '62%';

/**
 * The chrome every composer panel wears: a title, a collapse toggle and a close.
 *
 * The toggle exists because a cap is not always enough. Reading four messages
 * back to find an address, then typing it into a field, is a real thing reps do,
 * and a 62 % panel leaves too little transcript for it. Collapsing hides the
 * panel's body **without unmounting it**, so a half-filled template survives
 * the trip and is still there on the way back — which is the whole point, and
 * the reason this is a wrapper rather than a flag inside each panel.
 */
const PanelFrame = ({
  title,
  icon,
  collapsed,
  onToggle,
  onClose,
  t,
  children,
}: {
  title: string;
  icon: IconName;
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  t: Translate;
  children: React.ReactNode;
}) => {
  const theme = useTheme();

  const square: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    minWidth: '32px',
    minHeight: '32px',
    border: 'none',
    borderRadius: theme.border.radius.sm,
    background: 'transparent',
    color: theme.font.color.tertiary,
    cursor: 'pointer',
    padding: 0,
  };

  return (
    <div
      className="wa-composer-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        maxHeight: collapsed ? undefined : PANEL_MAX_HEIGHT,
        borderTop: `1px solid ${theme.border.color.light}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[1],
          flex: '0 0 auto',
          padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
          background: theme.background.transparent.lighter,
        }}
      >
        <Glyph name={icon} />
        <span
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            fontSize: theme.font.size.xs,
            fontWeight: theme.font.weight.medium,
            color: theme.font.color.secondary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'chat.expandPanel' : 'chat.collapsePanel')}
          title={t(collapsed ? 'chat.expandPanel' : 'chat.collapsePanel')}
          style={square}
        >
          <Glyph name={collapsed ? 'chevron' : 'chevronDown'} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.cancel')}
          title={t('common.cancel')}
          style={square}
        >
          <Glyph name="dismiss" />
        </button>
      </div>

      {/*
        `display: none`, not a conditional render. Unmounting would throw away
        the draft the rep is halfway through, which is the opposite of what a
        collapse is for.
      */}
      <div
        style={{
          display: collapsed ? 'none' : 'flex',
          flexDirection: 'column',
          minHeight: 0,
          flex: '1 1 auto',
        }}
      >
        {children}
      </div>
    </div>
  );
};

/**
 * The emoji the ☺ button offers, appended to the end of the draft.
 *
 * Appended, not inserted at the caret, and that is a deliberate limitation
 * rather than an oversight: Twenty does not forward `onSelect`, and calling
 * `setSelectionRange()` or `.focus()` on a ref throws — so there is no way to
 * know where the caret is, and a picker that guessed would move a rep's text
 * at random. The spec is explicit that caret-aware insertion waits for a tested
 * event-based strategy.
 */
const DRAFT_EMOJI = [
  '🙂', '😀', '😅', '😊', '😍', '🤔', '👍', '👏',
  '🙏', '🎉', '❤️', '🔥', '✅', '❌', '⚠️', '📍',
] as const;

const actionStyle = (
  theme: ReturnType<typeof useTheme>,
  emphasis: 'loud' | 'quiet' | 'disabled',
): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: theme.spacing[1],
  minHeight: '32px',
  border:
    emphasis === 'quiet' ? `1px solid ${theme.border.color.medium}` : '1px solid transparent',
  borderRadius: theme.border.radius.sm,
  background:
    emphasis === 'loud'
      ? theme.color.blue
      : emphasis === 'disabled'
        ? theme.background.transparent.light
        : 'transparent',
  color:
    emphasis === 'loud'
      ? theme.font.color.inverted
      : emphasis === 'disabled'
        ? theme.font.color.tertiary
        : theme.font.color.secondary,
  cursor: emphasis === 'disabled' ? 'default' : 'pointer',
  fontFamily: theme.font.family,
  fontSize: theme.font.size.sm,
  padding: `0 ${theme.spacing[2]}`,
  whiteSpace: 'nowrap',
});

type SheetEntry = {
  key: string;
  icon: IconName;
  label: string;
  mode: ComposerMode;
  /** The capability that governs it, or null for the always-available ones. */
  capability: keyof ThreadCapabilities;
};

const SHEET: SheetEntry[] = [
  {
    key: 'photo',
    icon: 'photo',
    label: 'chat.attachPhoto',
    mode: { kind: 'attachment', initial: 'image' },
    capability: 'media',
  },
  {
    key: 'document',
    icon: 'document',
    label: 'chat.attachDocument',
    mode: { kind: 'attachment', initial: 'document' },
    capability: 'media',
  },
  {
    key: 'voice',
    icon: 'voice',
    label: 'chat.attachVoice',
    mode: { kind: 'voice' },
    capability: 'media',
  },
  {
    key: 'location',
    icon: 'location',
    label: 'chat.attachLocation',
    mode: { kind: 'location' },
    capability: 'location',
  },
  {
    key: 'contact',
    icon: 'contactCard',
    label: 'chat.attachContact',
    mode: { kind: 'contact' },
    capability: 'contacts',
  },
  {
    key: 'quickReplies',
    icon: 'quickReplies',
    label: 'chat.attachQuickReplies',
    mode: { kind: 'interactive-buttons' },
    capability: 'interactive',
  },
  {
    key: 'list',
    icon: 'listMessage',
    label: 'chat.attachList',
    mode: { kind: 'interactive-list' },
    capability: 'interactive',
  },
  {
    key: 'template',
    icon: 'template',
    label: 'chat.attachTemplate',
    mode: { kind: 'template' },
    capability: 'template',
  },
];

export const Composer = ({
  policy,
  capabilities,
  templates,
  canSend,
  t,
  isSending,
  refusal,
  fieldErrors,
  replyTarget,
  person,
  onSendText,
  onSendTemplate,
  onSendMedia,
  onSendLocation,
  onSendContact,
  onSendInteractive,
  onCancelReply,
  onDismissRefusal,
}: ComposerProps) => {
  const theme = useTheme();
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<ComposerMode>({ kind: 'text' });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  /**
   * Reset whenever the mode changes, so a panel never opens already collapsed —
   * which would look exactly like the ＋ menu having done nothing.
   */
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  const allowed = policy?.allowed === true;
  const reason = policy?.allowed === false ? policy.reason : null;
  const windowClosed = reason === 'WINDOW_CLOSED';

  /**
   * A template is still sendable when the window is closed — that exemption is
   * what makes FR-OUT-5 true. It is not sendable when the contact opted out,
   * the thread is blocked or the number is down, so those denials hide the
   * button rather than swapping it in.
   */
  const templateAvailable =
    capabilities?.template.allowed ?? (canSend && (allowed || windowClosed));

  const submit = () => {
    const body = draft.trim();

    if (body.length === 0 || !allowed || !canSend || isSending) return;

    onSendText(body);
    setDraft('');
  };

  const open = (next: ComposerMode) => {
    setMode(next);
    setSheetOpen(false);
    setPanelCollapsed(false);
  };

  const close = () => {
    setMode({ kind: 'text' });
    setSheetOpen(false);
    setPanelCollapsed(false);
  };

  /** Every panel returns to the text box and clears the reply it consumed. */
  const afterSend = () => {
    close();
    onCancelReply();
  };

  const disabledReason = !canSend
    ? t('chat.noPermission')
    : reason === null
      ? null
      : t(`policy.${reason}`);

  const isAvailable = (entry: SheetEntry): boolean =>
    capabilities === undefined
      ? canSend && (allowed || entry.capability === 'template')
      : capabilities[entry.capability].allowed;

  /**
   * What the panel's own header says it is.
   *
   * Named here rather than inside each panel because the frame is shared, and
   * because a collapsed panel is *only* this line — "Approved template" has to
   * be enough to know what is folded away underneath.
   */
  const [panelIcon, panelTitle]: [IconName, string] = (() => {
    switch (mode.kind) {
      case 'template':
        return ['template', t('chat.attachTemplate')];
      case 'attachment':
        return ['attachment', t('chat.attach')];
      case 'voice':
        return ['voice', t('chat.attachVoice')];
      case 'location':
        return ['location', t('chat.attachLocation')];
      case 'contact':
        return ['contactCard', t('chat.attachContact')];
      case 'interactive-buttons':
        return ['quickReplies', t('chat.attachQuickReplies')];
      case 'interactive-list':
        return ['listMessage', t('chat.attachList')];
      default:
        return ['send', t('chat.send')];
    }
  })();

  const panel = ((): React.ReactNode => {
    switch (mode.kind) {
      case 'template':
        return (
          <TemplatePicker
            templates={templates}
            t={t}
            isSending={isSending}
            onCancel={close}
            onSend={(templateId, parameters) => {
              onSendTemplate(templateId, parameters);
              afterSend();
            }}
          />
        );

      case 'attachment':
        return (
          <AttachmentPanel
            t={t}
            isSending={isSending}
            initialKind={mode.initial}
            onCancel={close}
            onSend={(input) => {
              onSendMedia({
                mediaKind: input.mediaKind,
                fileUrl: input.fileUrl,
                filename: input.filename,
                caption: input.caption,
              });
              afterSend();
            }}
          />
        );

      case 'voice':
        return (
          <VoicePanel
            t={t}
            isSending={isSending}
            onSend={(input) => {
              onSendMedia({
                mediaKind: 'audio',
                ...(input.fileUrl.length === 0 ? {} : { fileUrl: input.fileUrl }),
                ...(input.filePath.length === 0 ? {} : { filePath: input.filePath }),
                filename: input.filename,
                caption: null,
                voice: true,
              });
              afterSend();
            }}
          />
        );

      case 'location':
        return (
          <LocationPanel
            t={t}
            isSending={isSending}
            onCancel={close}
            onSend={(location) => {
              onSendLocation(location);
              afterSend();
            }}
          />
        );

      case 'contact':
        return (
          <ContactPanel
            t={t}
            isSending={isSending}
            person={person}
            onCancel={close}
            onSend={(contact) => {
              onSendContact(contact);
              afterSend();
            }}
          />
        );

      case 'interactive-buttons':
      case 'interactive-list':
        return (
          <InteractiveBuilder
            kind={mode.kind === 'interactive-buttons' ? 'buttons' : 'list'}
            t={t}
            isSending={isSending}
            serverErrors={fieldErrors}
            onCancel={close}
            onSend={(interactive) => {
              void onSendInteractive(interactive).then((accepted) => {
                if (accepted) afterSend();
              });
            }}
          />
        );

      default:
        return null;
    }
  })();

  return (
    <div
      className="wa-composer"
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderTop: `1px solid ${theme.border.color.light}`,
        background: theme.background.primary,
      }}
    >
      {(policy?.warnings ?? []).length === 0 ? null : (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: theme.spacing[2],
            padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
            fontSize: theme.font.size.xs,
            color: theme.font.color.secondary,
            background: theme.background.transparent.light,
          }}
        >
          {(policy?.warnings ?? []).map((warning) => (
            <span
              key={warning}
              style={{ display: 'inline-flex', alignItems: 'center', gap: theme.spacing[1] }}
            >
              <Glyph name="warning" />
              {t(`warning.${warning}`)}
            </span>
          ))}
        </div>
      )}

      {refusal === null ? null : (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[2],
            padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
            fontSize: theme.font.size.sm,
            color: theme.font.color.danger,
            background: theme.background.transparent.danger,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.spacing[1] }}>
            <Glyph name="warning" />
            {t(`policy.${refusal}`)}
          </span>
          <span style={{ flex: '1 1 auto' }} />
          <button
            type="button"
            onClick={onDismissRefusal}
            aria-label={t('common.dismiss')}
            title={t('common.dismiss')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: '32px',
              minHeight: '32px',
              border: 'none',
              borderRadius: theme.border.radius.sm,
              background: 'transparent',
              color: theme.font.color.danger,
              cursor: 'pointer',
            }}
          >
            <Glyph name="dismiss" />
          </button>
        </div>
      )}

      {/*
        The reply strip stays above whichever panel is open: a rep who chose
        Reply and then opened the location panel is still replying, and the
        `contextWamid` travels with the location send.
      */}
      {replyTarget === null ? null : (
        <div style={{ padding: `${theme.spacing[1]} ${theme.spacing[2]} 0` }}>
          <QuoteStrip quote={replyTarget} t={t} onDismiss={onCancelReply} />
        </div>
      )}

      {panel === null ? null : (
        <PanelFrame
          title={panelTitle}
          icon={panelIcon}
          collapsed={panelCollapsed}
          onToggle={() => setPanelCollapsed((current) => !current)}
          onClose={close}
          t={t}
        >
          {panel}
        </PanelFrame>
      )}

      {panel !== null ? null : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing[1],
            padding: theme.spacing[2],
            // The containing block for the ＋ sheet and the emoji panel, both of
            // which are absolutely positioned because portals render nothing.
            position: 'relative',
          }}
        >
          {disabledReason === null ? null : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: theme.spacing[1],
                fontSize: theme.font.size.xs,
                color: theme.font.color.tertiary,
              }}
            >
              <Glyph name={windowClosed ? 'windowClosed' : 'warning'} />
              {disabledReason}
            </div>
          )}

          {sheetOpen ? (
            <div
              className="wa-composer-sheet"
              role="menu"
              aria-label={t('chat.attachTitle')}
              style={{
                position: 'absolute',
                bottom: '100%',
                left: theme.spacing[2],
                right: theme.spacing[2],
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: theme.spacing[1],
                border: `1px solid ${theme.border.color.medium}`,
                borderRadius: theme.border.radius.md,
                background: theme.background.primary,
                boxShadow: theme.boxShadow.strong,
                padding: theme.spacing[1],
                zIndex: 2,
              }}
            >
              {SHEET.map((entry) => {
                const available = isAvailable(entry);

                return (
                  <button
                    key={entry.key}
                    type="button"
                    role="menuitem"
                    disabled={!available}
                    title={available ? undefined : t('chat.unavailableHere')}
                    onClick={() => open(entry.mode)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: theme.spacing[1],
                      minHeight: '32px',
                      border: 'none',
                      borderRadius: theme.border.radius.sm,
                      background: 'transparent',
                      color: available
                        ? theme.font.color.secondary
                        : theme.font.color.light,
                      cursor: available ? 'pointer' : 'default',
                      fontFamily: theme.font.family,
                      fontSize: theme.font.size.sm,
                      padding: `0 ${theme.spacing[1]}`,
                      textAlign: 'left',
                    }}
                  >
                    <Glyph name={entry.icon} size="md" />
                    {t(entry.label)}
                  </button>
                );
              })}
            </div>
          ) : null}

          {emojiOpen ? (
            <div
              className="wa-composer-emoji"
              style={{
                position: 'absolute',
                bottom: '100%',
                left: theme.spacing[2],
                display: 'grid',
                gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
                gap: theme.spacing[0.5],
                border: `1px solid ${theme.border.color.medium}`,
                borderRadius: theme.border.radius.md,
                background: theme.background.primary,
                boxShadow: theme.boxShadow.strong,
                padding: theme.spacing[1],
                zIndex: 2,
              }}
            >
              {DRAFT_EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setDraft((current) => `${current}${emoji}`)}
                  aria-label={emoji}
                  title={emoji}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: '32px',
                    minHeight: '32px',
                    border: 'none',
                    borderRadius: theme.border.radius.sm,
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: theme.font.size.md,
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: theme.spacing[1], alignItems: 'flex-end' }}>
            <button
              type="button"
              onClick={() => {
                setSheetOpen((current) => !current);
                setEmojiOpen(false);
              }}
              aria-expanded={sheetOpen}
              aria-label={t('chat.attach')}
              title={t('chat.attach')}
              disabled={!canSend}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: '0 0 auto',
                minWidth: '32px',
                minHeight: '32px',
                border: `1px solid ${theme.border.color.medium}`,
                borderRadius: theme.border.radius.sm,
                background: 'transparent',
                color: canSend ? theme.font.color.secondary : theme.font.color.light,
                cursor: canSend ? 'pointer' : 'default',
                padding: 0,
              }}
            >
              <Glyph name="newCampaign" size="md" />
            </button>

            <button
              type="button"
              onClick={() => {
                setEmojiOpen((current) => !current);
                setSheetOpen(false);
              }}
              aria-expanded={emojiOpen}
              aria-label={t('chat.emoji')}
              title={t('chat.emoji')}
              disabled={!allowed || !canSend}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: '0 0 auto',
                minWidth: '32px',
                minHeight: '32px',
                border: `1px solid ${theme.border.color.medium}`,
                borderRadius: theme.border.radius.sm,
                background: 'transparent',
                color:
                  allowed && canSend ? theme.font.color.secondary : theme.font.color.light,
                cursor: allowed && canSend ? 'pointer' : 'default',
                padding: 0,
              }}
            >
              <Glyph name="react" size="md" />
            </button>

            <textarea
              value={draft}
              disabled={!allowed || !canSend}
              maxLength={MAX_TEXT_LENGTH}
              rows={2}
              placeholder={t('chat.placeholder')}
              aria-label={t('chat.placeholder')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                resize: 'none',
                border: `1px solid ${theme.border.color.medium}`,
                borderRadius: theme.border.radius.sm,
                background: allowed
                  ? theme.background.secondary
                  : theme.background.transparent.light,
                color: theme.font.color.primary,
                fontFamily: theme.font.family,
                fontSize: theme.font.size.sm,
                padding: theme.spacing[1],
              }}
            />

            {/*
              Template first, Send second, always in that order and always in
              this row. `emphasis` is the only thing the policy moves — the
              control never changes size, shape or position, which is what it
              used to do at the exact moment a rep needed to find it.
            */}
            {templateAvailable ? (
              <button
                type="button"
                onClick={() => open({ kind: 'template' })}
                aria-label={t('chat.chooseTemplate')}
                style={actionStyle(theme, allowed ? 'quiet' : 'loud')}
              >
                <Glyph name="template" size="md" />
                {t('chat.chooseTemplate')}
              </button>
            ) : null}

            {allowed && canSend ? (
              <button
                type="button"
                onClick={submit}
                disabled={draft.trim().length === 0 || isSending}
                aria-label={t('chat.send')}
                style={actionStyle(
                  theme,
                  draft.trim().length === 0 || isSending ? 'disabled' : 'loud',
                )}
              >
                <Glyph name="send" size="md" />
                {isSending ? t('chat.sending') : t('chat.send')}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
