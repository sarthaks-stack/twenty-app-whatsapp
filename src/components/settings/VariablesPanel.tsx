import { useEffect, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { Translate } from '../common/copy';
import { ActionButton, Banner, Card, useInputStyle } from '../common/ui';

/**
 * The application variables, editable (FR-CON-3, NFR-M1).
 *
 * **This screen exists because our own settings surface removed the platform's
 * one.** `defineSettingsFrontComponent` replaces Twenty's variable editor
 * instead of sitting beside it, so every variable the app declares became a
 * constant the moment this app shipped a settings tab — including the opt-out
 * confirmation, whose whole reason for being a variable is that counsel can
 * reword it without a deploy. The Diagnostics tab even sent the operator to a
 * "Variables" tab that no longer existed.
 *
 * Edits are per-variable rather than one big Save. These are unrelated settings
 * whose only shared property is where they are stored; a single button would
 * make changing a retention window and changing legal wording the same action.
 */

export type EditableVariable = {
  key: string;
  value: string;
  description: string;
  type: string;
  options: unknown;
};

type SelectOption = { label: string; value: string };

const optionsOf = (options: unknown): SelectOption[] =>
  Array.isArray(options)
    ? options.flatMap((option) => {
        const entry = option as { label?: unknown; value?: unknown };

        return typeof entry?.value === 'string'
          ? [{ label: String(entry.label ?? entry.value), value: entry.value }]
          : [];
      })
    : [];

const VariableRow = ({
  variable,
  busy,
  t,
  onSave,
}: {
  variable: EditableVariable;
  busy: boolean;
  t: Translate;
  onSave: (key: string, value: string) => Promise<boolean>;
}) => {
  const theme = useTheme();
  const inputStyle = useInputStyle();

  const [draft, setDraft] = useState(variable.value);

  /**
   * The server's value wins whenever it changes — a save returns the whole set,
   * and someone else's edit must not be masked by a stale draft. It is keyed on
   * the value rather than run on mount because this row is not remounted
   * between saves.
   */
  useEffect(() => setDraft(variable.value), [variable.value]);

  const dirty = draft !== variable.value;
  const choices = optionsOf(variable.options);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[1],
        borderTop: `1px solid ${theme.border.color.light}`,
        paddingTop: theme.spacing[2],
      }}
    >
      <span
        style={{
          fontSize: theme.font.size.xs,
          fontWeight: theme.font.weight.semiBold,
          fontFamily: theme.font.family,
        }}
      >
        {variable.key}
      </span>
      <span style={{ fontSize: theme.font.size.xxs, color: theme.font.color.tertiary }}>
        {variable.description}
      </span>

      <div style={{ display: 'flex', gap: theme.spacing[2], alignItems: 'flex-start' }}>
        {variable.type === 'BOOLEAN' ? (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: theme.spacing[1],
              fontSize: theme.font.size.xs,
              color: theme.font.color.secondary,
            }}
          >
            <input
              type="checkbox"
              checked={draft === 'true'}
              aria-label={variable.key}
              onChange={(event) => setDraft(event.target.checked ? 'true' : 'false')}
            />
            {t(draft === 'true' ? 'common.yes' : 'common.no')}
          </label>
        ) : choices.length > 0 ? (
          <select
            value={draft}
            aria-label={variable.key}
            onChange={(event) => setDraft(event.target.value)}
            style={{ ...inputStyle, flex: '1 1 auto' }}
          >
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        ) : (
          /**
           * A textarea for everything else, including the arrays and the
           * confirmation sentences. The confirmations run to two lines and the
           * keyword lists are stored as JSON, and a single-line input turns
           * both into a horizontal scroll.
           */
          <textarea
            value={draft}
            aria-label={variable.key}
            rows={draft.length > 60 ? 3 : 1}
            onChange={(event) => setDraft(event.target.value)}
            style={{ ...inputStyle, flex: '1 1 auto', resize: 'vertical' }}
          />
        )}

        <ActionButton
          label={t('common.save')}
          tone="primary"
          busy={busy}
          disabled={!dirty}
          onClick={async () => {
            const saved = await onSave(variable.key, draft);

            // A refused save keeps the operator's text on screen. Reverting it
            // to the stored value would throw away what they typed and leave
            // only an error to explain where it went.
            if (!saved) return;
          }}
        />
        {dirty ? (
          <ActionButton label={t('common.cancel')} onClick={() => setDraft(variable.value)} />
        ) : null}
      </div>
    </div>
  );
};

export const VariablesPanel = ({
  variables,
  busy,
  t,
  onSave,
}: {
  variables: EditableVariable[];
  busy: boolean;
  t: Translate;
  onSave: (key: string, value: string) => Promise<boolean>;
}) => (
  <Card title={t('settings.tab.variables')}>
    <Banner>{t('settings.variablesNote')}</Banner>

    {variables.length === 0 ? <Banner>{t('common.loading')}</Banner> : null}

    {variables.map((variable) => (
      <VariableRow
        key={variable.key}
        variable={variable}
        busy={busy}
        t={t}
        onSave={onSave}
      />
    ))}
  </Card>
);
