import { describe, expect, it } from 'vitest';

import type { AccountProjection } from '../../domain/feed/projection';
import { accountWarnings, standIn } from './CampaignBuilder';

const account = (over: Partial<AccountProjection> = {}): AccountProjection => ({
  id: 'a1',
  name: 'Vendas',
  status: 'CONNECTED',
  statusDetail: null,
  qualityRating: 'GREEN',
  messagingLimitTier: 'TIER_1K',
  tierUniqueUsersUsed: 0,
  displayPhoneNumber: '+244 923 456 789',
  displayName: 'Vendas',
  isTestAccount: false,
  webhookLastEventAt: null,
  webhookLastVerifiedAt: null,
  tokenLastCheckedAt: null,
  ...over,
});

/**
 * The Review step's job is to say what is wrong *before* anybody builds an
 * audience. Three of these are survivable and one of them means the campaign
 * will not start at all, so they are separate strings rather than one banner.
 */
describe('accountWarnings', () => {
  it('says nothing about a healthy number', () => {
    expect(accountWarnings(account())).toEqual([]);
  });

  it('treats no account at all as a disconnected one', () => {
    expect(accountWarnings(null)).toEqual(['campaign.warnNotConnected']);
  });

  it('reports a number that is not connected', () => {
    expect(accountWarnings(account({ status: 'PENDING' }))).toEqual([
      'campaign.warnNotConnected',
    ]);
  });

  it('reports a red rating, which the launch gate will ask about again', () => {
    expect(accountWarnings(account({ qualityRating: 'RED' }))).toEqual([
      'campaign.warnQualityRed',
    ]);
  });

  it('reports a yellow rating without pretending it blocks anything', () => {
    expect(accountWarnings(account({ qualityRating: 'YELLOW' }))).toEqual([
      'campaign.warnQualityYellow',
    ]);
  });

  /** Meta only delivers a test number's messages to registered recipients. */
  it('reports a test number', () => {
    expect(accountWarnings(account({ isTestAccount: true }))).toEqual([
      'campaign.warnTestAccount',
    ]);
  });

  it('reports every problem a number has at once', () => {
    expect(
      accountWarnings(account({ status: 'ERROR', qualityRating: 'RED', isTestAccount: true })),
    ).toEqual([
      'campaign.warnNotConnected',
      'campaign.warnQualityRed',
      'campaign.warnTestAccount',
    ]);
  });
});

/**
 * The Variables step's preview updates on every keystroke, so it cannot ask the
 * server what a contact's name is. What it can do is show the *shape* of the
 * finished sentence without ever pretending a stand-in is real data.
 */
describe('standIn', () => {
  it('shows a static binding as itself', () => {
    expect(standIn({ kind: 'static', path: '', value: 'Agosto', fallback: '' })).toBe('Agosto');
  });

  it('falls back to the fallback when a static binding is still empty', () => {
    expect(standIn({ kind: 'static', path: '', value: '', fallback: 'cliente' })).toBe(
      'cliente',
    );
  });

  /** Guillemets, so nobody reads it as the contact's actual first name. */
  it('shows a field binding as the field name in guillemets', () => {
    expect(
      standIn({ kind: 'field', path: 'person.name.firstName', value: '', fallback: '' }),
    ).toBe('«firstName»');
  });

  /**
   * An empty string leaves `bindPlaceholders` alone, so the preview keeps
   * showing `{{1}}` — which is the honest thing for a binding nobody has
   * chosen yet.
   */
  it('resolves to nothing when a field binding has no path', () => {
    expect(standIn({ kind: 'field', path: '', value: '', fallback: '' })).toBe('');
  });
});
