import { useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { Translate } from '../common/copy';
import type { FeedPolicy, FeedTemplate } from '../common/use-feed';
import type { ResolvedParameters } from '../../domain/template-render';
import { TemplatePicker } from './TemplatePicker';

/**
 * Where a rep types (specs/08 §3.3, FR-OUT-1, FR-OUT-2).
 *
 * Every state below is driven by the server's `policy`. The composer does not
 * know what the 24-hour rule is and must not: the rule lives in one pure module
 * that the send route re-runs immediately before the Meta call (AR-17), so a
 * component that re-derived it would eventually enable a button for a send that
 * is about to be refused.
 *
 * `WINDOW_CLOSED` is the interesting denial. It does not merely disable the
 * box — it *replaces* the primary action with **Escolher modelo**, because a
 * closed window is not a dead end, it is an instruction (FR-OUT-5).
 *
 * Sandbox mechanics: the textarea is controlled and never autofocused
 * (`.focus()` throws), Enter sends and Shift+Enter breaks the line, and a
 * refusal renders inline rather than as a toast — a toast that has faded cannot
 * be re-read.
 */

export type ComposerProps = {
  policy: FeedPolicy | undefined;
  templates: FeedTemplate[];
  canSend: boolean;
  t: Translate;
  isSending: boolean;
  /** A `DENIAL` code from a 409, kept on screen until the rep acts. */
  refusal: string | null;
  onSendText: (body: string) => void;
  onSendTemplate: (templateId: string, parameters: ResolvedParameters) => void;
  onDismissRefusal: () => void;
};

export const MAX_TEXT_LENGTH = 4096;

export const Composer = ({
  policy,
  templates,
  canSend,
  t,
  isSending,
  refusal,
  onSendText,
  onSendTemplate,
  onDismissRefusal,
}: ComposerProps) => {
  const theme = useTheme();
  const [draft, setDraft] = useState('');
  const [showPicker, setShowPicker] = useState(false);

  const allowed = policy?.allowed === true;
  const reason = policy?.allowed === false ? policy.reason : null;
  const windowClosed = reason === 'WINDOW_CLOSED';

  /**
   * A template is still sendable when the window is closed — that exemption is
   * what makes FR-OUT-5 true. It is not sendable when the contact opted out,
   * the thread is blocked or the number is down, so those denials hide the
   * button rather than swapping it in.
   */
  const templateAvailable = canSend && (allowed || windowClosed);

  const submit = () => {
    const body = draft.trim();

    if (body.length === 0 || !allowed || !canSend || isSending) return;

    onSendText(body);
    setDraft('');
  };

  const disabledReason = !canSend
    ? t('chat.noPermission')
    : reason === null
      ? null
      : t(`policy.${reason}`);

  return (
    <div
      className="wa-composer"
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderTop: `1px solid ${theme.border.color.light}`,
      }}
    >
      {(policy?.warnings ?? []).length === 0 ? null : (
        <div
          style={{
            display: 'flex',
            gap: theme.spacing[2],
            padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
            fontSize: theme.font.size.xxs,
            color: theme.font.color.secondary,
            background: theme.background.transparent.light,
          }}
        >
          {(policy?.warnings ?? []).map((warning) => (
            <span key={warning}>⚠ {t(`warning.${warning}`)}</span>
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
            fontSize: theme.font.size.xs,
            color: theme.font.color.danger,
            background: theme.background.transparent.danger,
          }}
        >
          <span>⚠ {t(`policy.${refusal}`)}</span>
          <button
            type="button"
            onClick={onDismissRefusal}
            aria-label={t('common.dismiss')}
            style={{
              border: 'none',
              background: 'transparent',
              color: theme.font.color.danger,
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {showPicker ? (
        <TemplatePicker
          templates={templates}
          t={t}
          isSending={isSending}
          onCancel={() => setShowPicker(false)}
          onSend={(templateId, parameters) => {
            onSendTemplate(templateId, parameters);
            setShowPicker(false);
          }}
        />
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing[1],
            padding: theme.spacing[2],
          }}
        >
          {disabledReason === null ? null : (
            <div style={{ fontSize: theme.font.size.xxs, color: theme.font.color.tertiary }}>
              {disabledReason}
            </div>
          )}

          <div style={{ display: 'flex', gap: theme.spacing[2], alignItems: 'flex-end' }}>
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

            {allowed && canSend ? (
              <button
                type="button"
                onClick={submit}
                disabled={draft.trim().length === 0 || isSending}
                aria-label={t('chat.send')}
                style={{
                  border: 'none',
                  borderRadius: theme.border.radius.sm,
                  background:
                    draft.trim().length === 0
                      ? theme.background.transparent.light
                      : theme.color.blue,
                  color:
                    draft.trim().length === 0
                      ? theme.font.color.tertiary
                      : theme.font.color.inverted,
                  cursor: draft.trim().length === 0 ? 'default' : 'pointer',
                  fontSize: theme.font.size.xs,
                  padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {isSending ? t('chat.sending') : t('chat.send')}
              </button>
            ) : null}

            {templateAvailable && !allowed ? (
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                aria-label={t('chat.chooseTemplate')}
                style={{
                  border: 'none',
                  borderRadius: theme.border.radius.sm,
                  background: theme.color.blue,
                  color: theme.font.color.inverted,
                  cursor: 'pointer',
                  fontSize: theme.font.size.xs,
                  padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {t('chat.chooseTemplate')}
              </button>
            ) : null}
          </div>

          {templateAvailable && allowed ? (
            <button
              type="button"
              onClick={() => setShowPicker(true)}
              aria-label={t('chat.chooseTemplate')}
              style={{
                alignSelf: 'flex-start',
                border: 'none',
                background: 'transparent',
                color: theme.font.color.tertiary,
                cursor: 'pointer',
                fontSize: theme.font.size.xxs,
                padding: 0,
              }}
            >
              {t('chat.chooseTemplate')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
};
