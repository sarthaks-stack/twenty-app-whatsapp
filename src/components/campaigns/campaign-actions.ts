import { useCallback, useMemo } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';

/**
 * The campaign control route, from the browser (specs/07 §9, SEC-12).
 *
 * Every arm is admin-only server-side except `preview` and `preflight`, which
 * are agent-level: a rep looking at what a campaign will say is not a
 * privileged act, sending it is. The UI hides what `permissions` says the caller
 * cannot do, and the route refuses it again regardless.
 */

export type CampaignAction =
  | 'audienceOptions'
  | 'create'
  | 'update'
  | 'build'
  | 'preview'
  | 'preflight'
  | 'testSend'
  | 'launch'
  | 'pause'
  | 'resume'
  | 'cancel';

export type CampaignCallResult<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | { ok: false; status: number | null; error: string };

export const useCampaignActions = () => {
  const client = useMemo(() => new RestApiClient(), []);

  const call = useCallback(
    async <T = Record<string, unknown>>(
      action: CampaignAction,
      body: Record<string, unknown> = {},
    ): Promise<CampaignCallResult<T>> => {
      try {
        return { ok: true, data: await client.post<T>('/s/whatsapp/campaign', { action, ...body }) };
      } catch (error) {
        const detail = error as { status?: number; body?: { error?: string } };

        return {
          ok: false,
          status: detail?.status ?? null,
          /**
           * The route's refusals are sentences an operator can act on — "this
           * campaign has no recipients", "quality is RED" — so they are shown
           * verbatim rather than mapped through the copy table. They are the
           * one place the server writes prose, and specs/07 §9 wrote it
           * deliberately.
           */
          error:
            detail?.body?.error ??
            (error instanceof Error ? error.message : String(error)),
        };
      }
    },
    [client],
  );

  return { call };
};
