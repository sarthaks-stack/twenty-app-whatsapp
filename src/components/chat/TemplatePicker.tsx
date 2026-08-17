import { useEffect, useMemo, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import { bodyVariableHints, buttonLabels } from '../../domain/template-hints';
import {
  emptyParameters,
  isBlank,
  renderTemplate,
  validateParameters,
  type ResolvedParameters,
} from '../../domain/template-render';
import type { VariableSpec } from '../../domain/template-spec';
import type { Translate } from '../common/copy';
import { Glyph } from '../common/icons';
import type { FeedTemplate } from '../common/use-feed';

/**
 * Choosing a template and filling it in (FR-TPL-3, specs/08 §3.3).
 *
 * The preview is rendered by `renderTemplate` — the *same* pure function the
 * campaign snapshot and the send path use. A picker with its own placeholder
 * substitution would eventually show a rep something different from what the
 * customer receives, and the difference would only be discovered by the
 * customer.
 *
 * `validateParameters` decides when **Enviar** is available, for the same
 * reason: Meta rejects a template with an empty parameter, so the rule that
 * excludes a campaign recipient is the rule that disables this button.
 *
 * The list is already filtered server-side to published, usable, approved
 * templates (FR-TPL-2) — nothing here re-derives that.
 *
 * ---
 *
 * **What this form got wrong, and what fixed it.** Sending a six-variable
 * template meant six boxes labelled `{{1}}` … `{{6}}`, a preview below the fold
 * that still read `{{1}}`, and Send and Cancel scrolled off the bottom of the
 * pane — with the conversation itself pushed entirely out of view. A rep had to
 * guess what `{{4}}` was, could not see whether they had guessed right, and
 * could not reach the button that would tell them.
 *
 * Four changes, and each answers one of those:
 *
 * - **Every field is labelled with the words around it.** `📅 Data: {{4}}
 *   (hora de Luanda)` is the label; Meta's own synced example is the input's
 *   placeholder (`template-hints.ts`). None of that is new data — the picker
 *   simply never read it.
 * - **The preview updates as you type**, sits above the fields where a reader
 *   looks first, and draws the buttons the body refers to.
 * - **The header and the footer are pinned**, so the template being edited and
 *   the two actions are visible from any scroll position. Only the middle
 *   scrolls.
 * - **A missing variable is marked on its own field**, not summarised as a list
 *   of indices under a preview nobody could see.
 */

export type TemplatePickerProps = {
  templates: FeedTemplate[];
  t: Translate;
  onCancel: () => void;
  onSend: (templateId: string, parameters: ResolvedParameters) => void;
  isSending: boolean;
};

const specOf = (template: FeedTemplate | null): VariableSpec | null => {
  const raw = template?.variableSpec;

  return raw === null || raw === undefined ? null : (raw as unknown as VariableSpec);
};

export const TemplatePicker = ({
  templates,
  t,
  onCancel,
  onSend,
  isSending,
}: TemplatePickerProps) => {
  const theme = useTheme();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<string[]>([]);
  /** Empty fields are marked only once a send has been attempted. */
  const [attempted, setAttempted] = useState(false);

  /**
   * One template is not a choice.
   *
   * The list opened on `—` even when there was exactly one thing to pick, so
   * the first act of every template send was a decision with one option. It
   * also meant the panel opened showing nothing at all, which is the worst
   * possible answer to "why did my conversation disappear".
   */
  useEffect(() => {
    if (selectedId === null && templates.length === 1) {
      setSelectedId(templates[0]!.id);
    }
  }, [selectedId, templates]);

  const selected = templates.find((template) => template.id === selectedId) ?? null;
  const spec = specOf(selected);

  const hints = useMemo(() => bodyVariableHints(spec), [spec]);
  const buttons = useMemo(() => buttonLabels(spec), [spec]);

  const parameters: ResolvedParameters = useMemo(
    () => ({ ...emptyParameters(), body: values }),
    [values],
  );

  const validation = useMemo(
    () => (spec === null ? null : validateParameters(spec, parameters)),
    [spec, parameters],
  );

  const preview = useMemo(
    () => (spec === null ? null : renderTemplate(spec, parameters)),
    [spec, parameters],
  );

  const ready = selected !== null && validation?.ok === true;

  const submit = () => {
    setAttempted(true);

    if (!ready || isSending) return;

    onSend(selected.id, parameters);
  };

  const control: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: '32px',
    border: `1px solid ${theme.border.color.medium}`,
    borderRadius: theme.border.radius.sm,
    background: theme.background.secondary,
    color: theme.font.color.primary,
    fontFamily: theme.font.family,
    fontSize: theme.font.size.sm,
    padding: `0 ${theme.spacing[1]}`,
  };

  const action = (emphasis: 'loud' | 'quiet' | 'disabled'): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing[1],
    minHeight: '32px',
    border:
      emphasis === 'quiet'
        ? `1px solid ${theme.border.color.medium}`
        : '1px solid transparent',
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
  });

  return (
    <div
      className="wa-template-picker"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        // The panel is a column with one scrolling middle; the two ends stay put.
        overflow: 'hidden',
      }}
    >
      {/*
        The select is the panel's own control; the panel's *name* is on the frame
        above it (`PanelFrame`), so repeating "Choose a template" as a visible
        label would be the same words twice in adjacent rows.
      */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[1],
          flex: '0 0 auto',
          padding: `${theme.spacing[2]} ${theme.spacing[2]} ${theme.spacing[1]}`,
        }}
      >
        <select
          id="wa-template-select"
          aria-label={t('chat.chooseTemplate')}
          value={selectedId ?? ''}
          onChange={(event) => {
            setSelectedId(event.target.value === '' ? null : event.target.value);
            // A different template means different variables; carrying the old
            // values over would fill {{2}} with something meant for {{1}}.
            setValues([]);
            setAttempted(false);
          }}
          style={{ ...control, flex: '1 1 auto', minWidth: 0 }}
        >
          <option value="">—</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} ({template.language}) · {template.category}
            </option>
          ))}
        </select>
      </header>

      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: theme.spacing[2],
          padding: `0 ${theme.spacing[2]}`,
        }}
      >
        {templates.length === 0 ? (
          <div style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}>
            {t('chat.noTemplates')}
          </div>
        ) : null}

        {/*
          The preview first. It is what the rep is trying to produce, it changes
          as they type, and putting it under six inputs is what made it
          invisible — a template with six variables pushed it past the fold on
          every pane this component renders in.
        */}
        {preview === null ? null : (
          <div
            style={{
              border: `1px solid ${theme.border.color.light}`,
              borderRadius: theme.border.radius.md,
              background: theme.background.transparent.lighter,
              padding: theme.spacing[2],
              display: 'flex',
              flexDirection: 'column',
              gap: theme.spacing[1],
            }}
          >
            <span
              style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}
            >
              {t('builder.preview')}
            </span>
            {preview.header === null ? null : (
              <div
                style={{
                  fontSize: theme.font.size.sm,
                  fontWeight: theme.font.weight.semiBold,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {preview.header}
              </div>
            )}
            <div
              style={{
                fontSize: theme.font.size.sm,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {preview.body}
            </div>
            {preview.footer === null ? null : (
              <div
                style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}
              >
                {preview.footer}
              </div>
            )}
            {buttons.length === 0 ? null : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.spacing[0.5],
                  marginTop: theme.spacing[0.5],
                }}
              >
                {buttons.map((label) => (
                  <span
                    key={label}
                    style={{
                      textAlign: 'center',
                      border: `1px solid ${theme.border.color.light}`,
                      borderRadius: theme.border.radius.sm,
                      padding: `${theme.spacing[0.5]} ${theme.spacing[1]}`,
                      fontSize: theme.font.size.xs,
                      color: theme.color.blue,
                    }}
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {hints.map((hint, index) => {
          const value = values[index] ?? '';
          const missing = attempted && isBlank(value);
          const id = `wa-template-var-${index}`;

          return (
            <div
              key={hint.token}
              style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[0.5] }}
            >
              <label
                htmlFor={id}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: theme.spacing[1],
                  fontSize: theme.font.size.xs,
                  color: theme.font.color.secondary,
                }}
              >
                {/*
                  The words around the placeholder, which is what actually tells
                  a rep what belongs here. The token stays beside it, small, as
                  the unambiguous identity — two people discussing "the fourth
                  variable" still need to see which one that is.
                */}
                <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                  {hint.context ?? hint.token}
                </span>
                <span style={{ color: theme.font.color.light, flex: '0 0 auto' }}>
                  {hint.token}
                </span>
              </label>
              <input
                id={id}
                type="text"
                value={value}
                placeholder={hint.example ?? undefined}
                aria-invalid={missing ? true : undefined}
                onChange={(event) => {
                  const next = event.target.value;

                  setValues((current) => {
                    const copy = [...current];

                    copy[index] = next;

                    return copy;
                  });
                }}
                style={{
                  ...control,
                  border: `1px solid ${
                    missing ? theme.border.color.danger : theme.border.color.medium
                  }`,
                }}
              />
              {missing ? (
                <span
                  role="alert"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: theme.spacing[1],
                    fontSize: theme.font.size.xs,
                    color: theme.font.color.danger,
                  }}
                >
                  <Glyph name="warning" />
                  {t('builder.error.REQUIRED')}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {/*
        Pinned, because the two things a rep needs at every moment are "send
        this" and "give me my conversation back" — and both used to be below
        the fold of a six-variable form.
      */}
      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[2],
          flex: '0 0 auto',
          borderTop: `1px solid ${theme.border.color.light}`,
          padding: theme.spacing[2],
        }}
      >
        {selected === null || validation?.ok === true ? null : (
          <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
            {t('chat.missing')}: {validation?.missingKeys.length ?? 0}
          </span>
        )}
        <span style={{ flex: '1 1 auto' }} />
        <button type="button" onClick={onCancel} style={action('quiet')}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={isSending}
          aria-label={t('chat.send')}
          style={action(ready && !isSending ? 'loud' : 'disabled')}
        >
          <Glyph name="send" size="md" />
          {isSending ? t('chat.sending') : t('chat.send')}
        </button>
      </footer>
    </div>
  );
};
