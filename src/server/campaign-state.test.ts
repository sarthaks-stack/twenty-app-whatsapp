import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The single gate every campaign status change passes through.
 *
 * `statusReason` is the sentence an operator reads to find out why a campaign
 * stopped — "quality_red", "tier_exhausted", "circuit_breaker". A `= null`
 * default on the parameter made "leave it alone" unreachable, so *every*
 * transition cleared it and the explanation survived only until the next
 * caller with nothing to say about it (D-43).
 */

const patchCampaign = vi.fn();
const audit = vi.fn();

vi.mock('./repositories/campaigns', () => ({
  patchCampaign: (...args: unknown[]) => patchCampaign(...args),
}));

vi.mock('./audit', () => ({
  audit: (...args: unknown[]) => audit(...args),
  AUDIT_ACTION: {
    CAMPAIGN_LAUNCH: 'campaign.launch',
    CAMPAIGN_PAUSE: 'campaign.pause',
    CAMPAIGN_CANCEL: 'campaign.cancel',
  },
}));

const { transitionCampaign } = await import('./campaign-state');

const campaign = (status: string) =>
  ({ id: 'c1', status, name: 'Festa', templateId: 't1', accountId: 'a1' }) as never;

const patchOf = (call = 0) => patchCampaign.mock.calls[call]?.[1] as Record<string, unknown>;

beforeEach(() => {
  patchCampaign.mockReset();
  audit.mockReset();
  patchCampaign.mockResolvedValue(undefined);
});

describe('what statusReason does', () => {
  it('sets the reason when one is given', async () => {
    await transitionCampaign({
      campaign: campaign('RUNNING'),
      to: 'PAUSED',
      reason: 'quality_red',
    });

    expect(patchOf()).toMatchObject({ status: 'PAUSED', statusReason: 'quality_red' });
  });

  /** The documented way to say "there is no longer a reason". */
  it('clears the reason when told to, explicitly', async () => {
    await transitionCampaign({ campaign: campaign('PAUSED'), to: 'RUNNING', reason: null });

    expect(patchOf()).toMatchObject({ status: 'RUNNING', statusReason: null });
  });

  /** The case the default made unreachable. */
  it('leaves the reason alone when none is given', async () => {
    await transitionCampaign({ campaign: campaign('RUNNING'), to: 'PAUSED' });

    expect(patchOf()).not.toHaveProperty('statusReason');
    expect(patchOf()).toMatchObject({ status: 'PAUSED' });
  });
});

describe('what a transition does besides', () => {
  it('refuses an edge the state machine does not allow, and writes nothing', async () => {
    const result = await transitionCampaign({ campaign: campaign('CANCELLED'), to: 'RUNNING' });

    expect(result).toMatchObject({ ok: false, from: 'CANCELLED' });
    expect(patchCampaign).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  /**
   * FR-CAM-8: pausing a paused campaign is not an error. The patch still
   * applies, because a tick reporting "no change of state, 40 more queued" is
   * carrying real information.
   */
  it('applies the patch on a no-op without rewriting the status', async () => {
    const result = await transitionCampaign({
      campaign: campaign('PAUSED'),
      to: 'PAUSED',
      patch: { sentCount: 40 },
    });

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(patchOf()).toEqual({ sentCount: 40 });
  });

  it('does not audit a no-op', async () => {
    await transitionCampaign({ campaign: campaign('PAUSED'), to: 'PAUSED' });

    expect(audit).not.toHaveBeenCalled();
  });

  it('audits a real pause with the campaign it belongs to', async () => {
    await transitionCampaign({
      campaign: campaign('RUNNING'),
      to: 'PAUSED',
      actorId: 'wm-1',
      reason: 'paused_by_admin',
    });

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      action: 'campaign.pause',
      actorId: 'wm-1',
      subject: { campaignId: 'c1', templateId: 't1', accountId: 'a1' },
      details: { from: 'RUNNING', to: 'PAUSED', reason: 'paused_by_admin' },
    });
  });

  it('reports null rather than undefined to the audit when no reason was given', async () => {
    await transitionCampaign({ campaign: campaign('RUNNING'), to: 'PAUSED' });

    expect(audit.mock.calls[0][0].details).toMatchObject({ reason: null });
  });
});
