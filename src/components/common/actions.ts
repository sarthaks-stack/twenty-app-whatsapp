import { useCallback, useMemo } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';

import type { ResolvedParameters } from '../../domain/template-render';

/**
 * Everything that changes something (specs/04, specs/05).
 *
 * Separate from `use-feed` because reads and writes fail differently and the
 * component has to treat them differently: a failed poll is a stale screen and
 * a banner, a failed send is a message the customer never received and a bubble
 * that must say so.
 *
 * Nothing here decides whether an action is *allowed*. The routes re-check the
 * caller's role and re-run the policy gate immediately before the Meta call
 * (SEC-5, AR-17); a disabled button is a courtesy, never a control.
 */

export type SendOutcome =
  | { ok: true; messageId: string; replayed: boolean }
  /** `409` — the policy gate refused. `code` is a `DENIAL`, never a sentence. */
  | { ok: false; kind: 'denied'; code: string; warnings: string[] }
  | { ok: false; kind: 'error'; message: string };

type ErrorBody = { code?: string; warnings?: string[]; error?: string; missing?: string[] };

const bodyOf = (error: unknown): { status: number | null; body: ErrorBody } => {
  const detail = error as { status?: number; body?: unknown };

  return {
    status: typeof detail?.status === 'number' ? detail.status : null,
    body:
      typeof detail?.body === 'object' && detail.body !== null
        ? (detail.body as ErrorBody)
        : {},
  };
};

/**
 * A token that survives a double-click, a re-render and a retried request.
 *
 * `crypto.randomUUID` is not guaranteed here, so it is used when present and
 * composed from the clock and two random draws when not — the requirement is
 * uniqueness within one workspace's sends, not cryptographic strength.
 */
export const newClientToken = (): string => {
  const random = globalThis.crypto;

  if (typeof random?.randomUUID === 'function') return random.randomUUID();

  return `wa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
};

export type ThreadActionName =
  | 'assign'
  | 'close'
  | 'reopen'
  | 'block'
  | 'unblock'
  | 'link'
  | 'relink'
  | 'markRead'
  | 'snooze';

export type Actions = {
  sendText: (input: {
    threadId: string;
    body: string;
    clientToken: string;
    contextWamid?: string | null;
  }) => Promise<SendOutcome>;
  sendTemplate: (input: {
    threadId?: string;
    accountId?: string;
    waId?: string;
    templateId: string;
    parameters: ResolvedParameters;
    clientToken: string;
  }) => Promise<SendOutcome>;
  threadAction: (
    action: ThreadActionName,
    input: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string }>;
};

export const useActions = (): Actions => {
  const client = useMemo(() => new RestApiClient(), []);

  const send = useCallback(
    async (payload: Record<string, unknown>): Promise<SendOutcome> => {
      try {
        const result = await client.post<{ message?: { id?: string }; replayed?: boolean }>(
          '/s/whatsapp/send',
          payload,
        );

        return {
          ok: true,
          messageId: result.message?.id ?? '',
          replayed: result.replayed === true,
        };
      } catch (error) {
        const { status, body } = bodyOf(error);

        /**
         * A denial is not an exception to be toasted and forgotten. It becomes
         * an inline state on the composer, because the rep has to *do*
         * something different — pick a template, or stop — and a toast that has
         * faded cannot be re-read (specs/08 §3.3).
         */
        if (status === 409 && typeof body.code === 'string') {
          return { ok: false, kind: 'denied', code: body.code, warnings: body.warnings ?? [] };
        }

        return {
          ok: false,
          kind: 'error',
          message:
            body.error ?? (error instanceof Error ? error.message : String(error)),
        };
      }
    },
    [client],
  );

  return {
    sendText: useCallback(
      ({ threadId, body, clientToken, contextWamid = null }) =>
        send({
          threadId,
          clientToken,
          message: { kind: 'text', body, contextWamid },
        }),
      [send],
    ),

    sendTemplate: useCallback(
      ({ threadId, accountId, waId, templateId, parameters, clientToken }) =>
        send({
          ...(threadId === undefined ? {} : { threadId }),
          ...(accountId === undefined ? {} : { accountId }),
          ...(waId === undefined ? {} : { waId }),
          clientToken,
          message: { kind: 'template', templateId, parameters },
        }),
      [send],
    ),

    threadAction: useCallback(
      async (action, input) => {
        try {
          await client.post('/s/whatsapp/thread', { action, ...input });

          return { ok: true };
        } catch (error) {
          const { body } = bodyOf(error);

          return {
            ok: false,
            error: body.error ?? (error instanceof Error ? error.message : String(error)),
          };
        }
      },
      [client],
    ),
  };
};
