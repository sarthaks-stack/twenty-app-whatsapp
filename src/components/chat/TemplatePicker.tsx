import { useMemo, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import {
  emptyParameters,
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

  const selected = templates.find((template) => template.id === selectedId) ?? null;
  const spec = specOf(selected);

  /** Positional or named, one ordering rule — `assessSupport` refuses mixtures. */
  const labels = useMemo(() => {
    if (spec === null) return [];

    return spec.namedParameters
      ? spec.body.names.map((name) => `{{${name}}}`)
      : spec.body.indices.map((index) => `{{${index}}}`);
  }, [spec]);

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

  const box: React.CSSProperties = {
    border: `1px solid ${theme.border.color.medium}`,
    borderRadius: theme.border.radius.sm,
    background: theme.background.secondary,
    color: theme.font.color.primary,
    fontSize: theme.font.size.sm,
    padding: theme.spacing[1],
    width: '100%',
  };

  return (
    <div
      className="wa-template-picker"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        padding: theme.spacing[2],
        borderTop: `1px solid ${theme.border.color.light}`,
      }}
    >
      {templates.length === 0 ? (
        <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
          {t('chat.noTemplates')}
        </div>
      ) : (
        <label style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
          <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}>
            {t('chat.chooseTemplate')}
          </span>
          <select
            value={selectedId ?? ''}
            onChange={(event) => {
              setSelectedId(event.target.value === '' ? null : event.target.value);
              // A different template means different variables; carrying the
              // old values over would fill {{2}} with something meant for {{1}}.
              setValues([]);
            }}
            style={box}
          >
            <option value="">—</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} ({template.language}) · {template.category}
              </option>
            ))}
          </select>
        </label>
      )}

      {labels.map((label, index) => (
        <label
          key={label}
          style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}
        >
          <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}>
            {label}
          </span>
          <input
            type="text"
            value={values[index] ?? ''}
            onChange={(event) => {
              const next = event.target.value;

              setValues((current) => {
                const copy = [...current];

                copy[index] = next;

                return copy;
              });
            }}
            style={box}
          />
        </label>
      ))}

      {preview === null ? null : (
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
          {preview.header === null ? null : (
            <div style={{ fontWeight: theme.font.weight.semiBold }}>{preview.header}</div>
          )}
          <div>{preview.body}</div>
          {preview.footer === null ? null : (
            <div style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
              {preview.footer}
            </div>
          )}
        </div>
      )}

      {validation !== null && !validation.ok ? (
        <div style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}>
          {t('chat.missing')}: {validation.missingKeys.join(', ')}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: theme.spacing[2] }}>
        <button
          type="button"
          onClick={() => {
            if (selected !== null && validation?.ok === true) {
              onSend(selected.id, parameters);
            }
          }}
          disabled={selected === null || validation?.ok !== true || isSending}
          aria-label={t('chat.send')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            minHeight: '32px',
            border: 'none',
            borderRadius: theme.border.radius.sm,
            background:
              selected === null || validation?.ok !== true
                ? theme.background.transparent.light
                : theme.color.blue,
            color:
              selected === null || validation?.ok !== true
                ? theme.font.color.tertiary
                : theme.font.color.inverted,
            cursor: selected === null || validation?.ok !== true ? 'default' : 'pointer',
            fontFamily: theme.font.family,
            fontSize: theme.font.size.sm,
            padding: `0 ${theme.spacing[2]}`,
          }}
        >
          <Glyph name="send" size="md" />
          {isSending ? t('chat.sending') : t('chat.send')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          aria-label={t('common.cancel')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: '32px',
            border: `1px solid ${theme.border.color.medium}`,
            borderRadius: theme.border.radius.sm,
            background: 'transparent',
            color: theme.font.color.secondary,
            cursor: 'pointer',
            fontFamily: theme.font.family,
            fontSize: theme.font.size.sm,
            padding: `0 ${theme.spacing[2]}`,
          }}
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
};
