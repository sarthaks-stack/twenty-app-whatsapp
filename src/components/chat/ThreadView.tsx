import { useCallback, useMemo, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { MessageProjection } from '../../domain/feed/projection';
import type { ResolvedParameters } from '../../domain/template-render';
import { newClientToken, useActions, type SendOutcome } from '../common/actions';
import { useCopy } from '../common/copy';
import { Glyph } from '../common/icons';
import { SURFACE_MAX_HEIGHT, SURFACE_MIN_HEIGHT } from '../common/surface';
import { ActionButton, Banner, EmptyState } from '../common/ui';
import { useFeed } from '../common/use-feed';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { StartConversation } from './StartConversation';
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
  /**
   * A failure from an action that is not an ordinary send, so it has no bubble
   * to settle onto — assigning, or opening a conversation that does not exist
   * yet. It renders as a banner rather than disappearing into a log.
   */
  const [actionError, setActionError] = useState<string | null>(null);

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
  const viewerId = feed.data?.permissions.workspaceMemberId ?? null;

  /**
   * Recomputed on every render rather than ticked on a timer: the countdown
   * only has to be right when something else caused a paint, and a second
   * interval per open conversation is a cost D-6 spends deliberately elsewhere.
   */
  const now = useMemo(() => new Date(feed.data?.serverTime ?? Date.now()), [feed.data]);

  /**
   * Every send ends here, and every send must end the optimistic bubble.
   *
   * A refused send creates no server row, so nothing a later poll returns will
   * ever replace the bubble — leaving a message that reads "queued" forever and
   * a conversation that shows something which was never sent. The bubble is
   * therefore settled explicitly on both failure paths, with the reason on it.
   */
  const handleOutcome = useCallback(
    (outcome: SendOutcome, clientToken: string) => {
      if (outcome.ok) {
        setRefusal(null);
        // Ask immediately rather than waiting for the next tick, so the bubble
        // stops saying "queued" as soon as the server has something better.
        feed.refresh();

        return;
      }

      if (outcome.kind === 'denied') {
        setRefusal(outcome.code);
        feed.settleOptimistic(clientToken, { error: t(`policy.${outcome.code}`) });

        return;
      }

      setRefusal(null);
      feed.settleOptimistic(clientToken, { error: outcome.message });
    },
    [feed, t],
  );

  const sendText = useCallback(
    async (body: string) => {
      if (thread === null) return;

      const clientToken = newClientToken();

      setIsSending(true);
      feed.addOptimistic(optimisticMessage(thread.id, clientToken, body, null));

      try {
        handleOutcome(
          await actions.sendText({ threadId: thread.id, body, clientToken }),
          clientToken,
        );
      } catch (error) {
        // A network failure is not an outcome the route reported; the bubble
        // still has to stop claiming it is on its way.
        feed.settleOptimistic(clientToken, {
          error: error instanceof Error ? error.message : t('error.unknown'),
        });
      } finally {
        setIsSending(false);
      }
    },
    [actions, feed, handleOutcome, t, thread],
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
          clientToken,
        );
      } catch (error) {
        feed.settleOptimistic(clientToken, {
          error: error instanceof Error ? error.message : t('error.unknown'),
        });
      } finally {
        setIsSending(false);
      }
    },
    [actions, feed, handleOutcome, t, templates, thread],
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

  /**
   * Take the conversation, or give it back.
   *
   * `assigneeId: null` is the unassign, which is why the route documents the
   * null rather than offering a second action. The button is only rendered
   * when the server named the caller — with no `workspaceMemberId` there is
   * nobody to assign *to*, and a button that silently assigned to null would
   * look like it had worked.
   */
  const toggleAssign = useCallback(async () => {
    if (thread === null || viewerId === null) return;

    const mine = thread.assigneeId === viewerId;
    const outcome = await actions.threadAction('assign', {
      threadId: thread.id,
      assigneeId: mine ? null : viewerId,
    });

    if (!outcome.ok) setActionError(outcome.error ?? t('chat.assignFailed'));
    else setActionError(null);

    feed.refresh();
  }, [actions, feed, t, thread, viewerId]);

  /**
   * Opening a conversation with a contact who has none.
   *
   * There is no thread to name, so the send route is addressed by account and
   * `waId` instead — both resolved by the server, because a `waId` assembled in
   * the browser from a display string is how a template reaches the wrong
   * person (see the feed route's person branch).
   */
  const startWithTemplate = useCallback(
    async (templateId: string, parameters: ResolvedParameters) => {
      const start = feed.data?.start;

      if (start?.waId === null || start?.waId === undefined) return;

      const clientToken = newClientToken();

      setIsSending(true);

      try {
        const outcome = await actions.sendTemplate({
          ...(start.accountId === null ? {} : { accountId: start.accountId }),
          waId: start.waId,
          templateId,
          parameters,
          clientToken,
        });

        if (outcome.ok) {
          setRefusal(null);
          // The conversation now exists; the next read is what makes it appear.
          feed.refresh();
        } else if (outcome.kind === 'denied') {
          setRefusal(outcome.code);
        } else {
          setRefusal(null);
          setActionError(outcome.message);
        }
      } finally {
        setIsSending(false);
      }
    },
    [actions, feed],
  );

  const shell: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    /**
     * The widget owns its own height and never grows the page. `height: 100%`
     * alone did not achieve that — the pane sizes itself to us, not the other
     * way round — so the cap is what actually holds. See `SURFACE_MAX_HEIGHT`.
     */
    maxHeight: SURFACE_MAX_HEIGHT,
    minHeight: variant === 'tab' ? SURFACE_MIN_HEIGHT : 0,
    background: theme.background.primary,
    color: theme.font.color.primary,
    fontFamily: theme.font.family,
    overflow: 'hidden',
  };

  /**
   * Nothing loaded, and a reason. Rendering the ordinary shell here would show
   * "no messages in this conversation yet" over a conversation the app simply
   * could not read — which is what a 403 looked like before D-53.
   */
  if (feed.isUnavailable) {
    return (
      <div className="wa-thread-view" style={{ ...shell, justifyContent: 'center' }}>
        <EmptyState
          icon="warning"
          title={t('common.unavailable')}
          body={feed.error ?? undefined}
          actions={
            <ActionButton label={t('common.retry')} icon="retry" onClick={feed.refresh} />
          }
        />
      </div>
    );
  }

  if (feed.data !== null && thread === null) {
    return (
      <div className="wa-thread-view" style={{ ...shell, justifyContent: 'center' }}>
        {actionError === null ? null : <Banner tone="danger">{actionError}</Banner>}
        {refusal === null ? null : <Banner tone="danger">{t(`policy.${refusal}`)}</Banner>}
        <StartConversation
          policy={feed.data.policy}
          templates={templates}
          start={feed.data.start}
          canSend={canSend}
          isSending={isSending}
          t={t}
          onSendTemplate={(templateId, parameters) =>
            void startWithTemplate(templateId, parameters)
          }
        />
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
            fontSize: theme.font.size.xs,
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
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.spacing[1],
              minHeight: '24px',
              border: `1px solid ${theme.border.color.medium}`,
              borderRadius: theme.border.radius.sm,
              background: 'transparent',
              color: theme.font.color.secondary,
              cursor: 'pointer',
              fontFamily: theme.font.family,
              fontSize: theme.font.size.xs,
              padding: `0 ${theme.spacing[2]}`,
            }}
          >
            <Glyph name="retry" />
            {t('chat.reconnect')}
          </button>
        </div>
      ) : null}

      {feed.isStale ? (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
            fontSize: theme.font.size.xs,
            background: theme.background.transparent.danger,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="warning" />
          {t('chat.offline')}
        </div>
      ) : null}

      {actionError === null ? null : <Banner tone="danger">{actionError}</Banner>}

      {thread === null ? null : (
        <ThreadHeader
          thread={thread}
          account={account}
          t={t}
          now={now}
          viewerId={viewerId}
          onToggleBlock={canSend ? toggleBlock : undefined}
          onClose={canSend ? toggleClose : undefined}
          onAssign={canSend && viewerId !== null ? toggleAssign : undefined}
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
