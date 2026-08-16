import { useCallback, useMemo, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { MessageProjection } from '../../domain/feed/projection';
import type { ResolvedParameters } from '../../domain/template-render';
import { newClientToken, useActions, type SendOutcome } from '../common/actions';
import { useCopy } from '../common/copy';
import { useFeed } from '../common/use-feed';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { ThreadHeader } from './ThreadHeader';

/**
 * The conversation, whole (specs/08 §3).
 *
 * The same component renders in the Person tab, the side panel and the inbox's
 * detail pane; only the chrome around it differs. That is not tidiness — it is
 * what makes specs/08 §10's fallback tiers a *routing* change rather than a
 * rewrite. If the probe says a rich widget is unusable, this component moves to
 * the side panel and nothing inside it changes.
 *
 * It owns exactly one piece of state the server does not: the optimistic
 * bubble. A rep pressing Enter sees their message immediately, keyed by its
 * `clientToken`, and the server's record replaces it rather than joining it.
 */

export type ThreadViewProps = {
  /** One of the two; `personId` resolves to that contact's newest conversation. */
  threadId?: string | null;
  personId?: string | null;
  /** Chrome only. The conversation is identical in all three. */
  variant?: 'tab' | 'panel' | 'inbox';
};

const optimisticMessage = (
  threadId: string,
  clientToken: string,
  body: string | null,
  templateName: string | null,
): MessageProjection => ({
  id: `local-${clientToken}`,
  wamid: null,
  direction: 'OUTBOUND',
  type: templateName === null ? 'TEXT' : 'TEMPLATE',
  status: 'QUEUED',
  body,
  waTimestamp: null,
  createdAt: new Date().toISOString(),
  statusTimestamps: {},
  errorCode: null,
  errorDetail: null,
  retryCount: 0,
  isRetryable: false,
  lane: 'INTERACTIVE',
  sourceKind: 'AGENT',
  templateName,
  templateLanguage: null,
  templateCategory: null,
  contextWamid: null,
  reactionTargetWamid: null,
  media: null,
  reactions: [],
  payload: null,
  clientToken,
  sentById: null,
  threadId,
});

export const ThreadView = ({
  threadId = null,
  personId = null,
  variant = 'tab',
}: ThreadViewProps) => {
  const theme = useTheme();
  const { t, lang } = useCopy();
  const actions = useActions();

  const [isSending, setIsSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const feed = useFeed({
    scope: 'thread',
    id: threadId ?? personId,
    by: threadId === null ? 'person' : 'thread',
    enabled: threadId !== null || personId !== null,
  });

  const thread = feed.data?.thread ?? null;
  const account = feed.data?.account ?? null;
  const templates = feed.data?.templates ?? [];
  const canSend = feed.data?.permissions.canSend === true;

  /**
   * Recomputed on every render rather than ticked on a timer: the countdown
   * only has to be right when something else caused a paint, and a second
   * interval per open conversation is a cost D-6 spends deliberately elsewhere.
   */
  const now = useMemo(() => new Date(feed.data?.serverTime ?? Date.now()), [feed.data]);

  const handleOutcome = useCallback(
    (outcome: SendOutcome) => {
      if (outcome.ok) {
        setRefusal(null);
        // Ask immediately rather than waiting for the next tick, so the bubble
        // stops saying "queued" as soon as the server has something better.
        feed.refresh();

        return;
      }

      if (outcome.kind === 'denied') {
        setRefusal(outcome.code);

        return;
      }

      setRefusal(null);
    },
    [feed],
  );

  const sendText = useCallback(
    async (body: string) => {
      if (thread === null) return;

      const clientToken = newClientToken();

      setIsSending(true);
      feed.addOptimistic(optimisticMessage(thread.id, clientToken, body, null));

      try {
        handleOutcome(await actions.sendText({ threadId: thread.id, body, clientToken }));
      } finally {
        setIsSending(false);
      }
    },
    [actions, feed, handleOutcome, thread],
  );

  const sendTemplate = useCallback(
    async (templateId: string, parameters: ResolvedParameters) => {
      if (thread === null) return;

      const clientToken = newClientToken();
      const name = templates.find((template) => template.id === templateId)?.name ?? null;

      setIsSending(true);
      feed.addOptimistic(optimisticMessage(thread.id, clientToken, null, name));

      try {
        handleOutcome(
          await actions.sendTemplate({
            threadId: thread.id,
            templateId,
            parameters,
            clientToken,
          }),
        );
      } finally {
        setIsSending(false);
      }
    },
    [actions, feed, handleOutcome, templates, thread],
  );

  /**
   * "Repetir" sends the same text again as a *new* message, with a new token.
   *
   * There is no re-queue route, and inventing one would mean reviving a record
   * the sender already decided about. A failed message never reached Meta —
   * that is what `FAILED` means after D-25 — so a fresh send is both safe and
   * the honest description of what is happening.
   */
  const retry = useCallback(
    (message: MessageProjection) => {
      if (message.body !== null) void sendText(message.body);
    },
    [sendText],
  );

  const toggleBlock = useCallback(async () => {
    if (thread === null) return;

    await actions.threadAction(thread.isBlocked ? 'unblock' : 'block', {
      threadId: thread.id,
    });
    feed.refresh();
  }, [actions, feed, thread]);

  const toggleClose = useCallback(async () => {
    if (thread === null) return;

    await actions.threadAction(thread.status === 'CLOSED' ? 'reopen' : 'close', {
      threadId: thread.id,
    });
    feed.refresh();
  }, [actions, feed, thread]);

  const shell: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: variant === 'tab' ? '420px' : 0,
    background: theme.background.primary,
    color: theme.font.color.primary,
    fontFamily: theme.font.family,
    /**
     * The widget owns its own height and never grows the page. A chat that
     * scrolled the record page instead of itself is the failure mode CLAUDE.md
     * names outright.
     */
    overflow: 'hidden',
  };

  if (feed.data !== null && thread === null) {
    return (
      <div className="wa-thread-view" style={{ ...shell, justifyContent: 'center' }}>
        <div
          style={{
            textAlign: 'center',
            color: theme.font.color.tertiary,
            fontSize: theme.font.size.sm,
            padding: theme.spacing[4],
          }}
        >
          {t('chat.noThread')}
        </div>
      </div>
    );
  }

  return (
    <div className="wa-thread-view" style={shell} {...feed.rootProps}>
      {feed.isSuspended ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[2],
            padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
            fontSize: theme.font.size.xxs,
            background: theme.background.transparent.light,
            color: theme.font.color.secondary,
          }}
        >
          <span>{t('chat.suspended')}</span>
          <button
            type="button"
            onClick={feed.resume}
            aria-label={t('chat.reconnect')}
            style={{
              border: `1px solid ${theme.border.color.medium}`,
              borderRadius: theme.border.radius.sm,
              background: 'transparent',
              color: theme.font.color.secondary,
              cursor: 'pointer',
              fontSize: theme.font.size.xxs,
              padding: `0 ${theme.spacing[1]}`,
            }}
          >
            {t('chat.reconnect')}
          </button>
        </div>
      ) : null}

      {feed.isStale ? (
        <div
          role="status"
          style={{
            padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
            fontSize: theme.font.size.xxs,
            background: theme.background.transparent.danger,
            color: theme.font.color.danger,
          }}
        >
          {t('chat.offline')}
        </div>
      ) : null}

      {thread === null ? null : (
        <ThreadHeader
          thread={thread}
          account={account}
          t={t}
          now={now}
          onToggleBlock={canSend ? toggleBlock : undefined}
          onClose={canSend ? toggleClose : undefined}
        />
      )}

      <MessageList
        messages={feed.messages}
        lang={lang}
        t={t}
        now={now}
        hasOlder={feed.hasOlder}
        isLoading={feed.isLoading}
        onLoadOlder={feed.loadOlder}
        onRetry={canSend ? retry : undefined}
      />

      <Composer
        policy={feed.data?.policy}
        templates={templates}
        canSend={canSend}
        t={t}
        isSending={isSending}
        refusal={refusal}
        onSendText={(body) => void sendText(body)}
        onSendTemplate={(templateId, parameters) => void sendTemplate(templateId, parameters)}
        onDismissRefusal={() => setRefusal(null)}
      />
    </div>
  );
};
