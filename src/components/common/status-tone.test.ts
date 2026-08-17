import { describe, expect, it } from 'vitest';

import { CAMPAIGN_STATUS } from '../../domain/constants';
import { TABLES } from './copy';
import { campaignStatusTone } from './ui';

/**
 * Colour is the third way a status says what it is, after the word and the
 * mark — but it is the one a reader takes in first, so what it is reserved for
 * matters.
 */
describe('campaignStatusTone', () => {
  it('reserves red for the state that actually needs someone', () => {
    const red = Object.values(CAMPAIGN_STATUS).filter(
      (status) => campaignStatusTone(status).color === 'red',
    );

    expect(red).toEqual(['FAILED']);
  });

  /**
   * A campaign somebody deliberately stopped is not a broken one. It used to
   * wear the same red as `FAILED`, which made a decision look like an incident.
   */
  it('does not paint a cancelled campaign as a failure', () => {
    expect(campaignStatusTone('CANCELLED').color).toBe('gray');
  });

  it('paints the states that are moving well in green', () => {
    expect(campaignStatusTone('RUNNING').color).toBe('green');
    expect(campaignStatusTone('COMPLETED').color).toBe('green');
  });

  it('gives paused and tier-waiting the same holding colour', () => {
    expect(campaignStatusTone('PAUSED').color).toBe('orange');
    expect(campaignStatusTone('TIER_WAITING').color).toBe('orange');
  });

  /**
   * Every status this app can produce must have a word in both languages, or a
   * pill somewhere renders a raw enum at a user.
   */
  it('has a translated word and a distinct mark for every campaign status', () => {
    for (const status of Object.values(CAMPAIGN_STATUS)) {
      const tone = campaignStatusTone(status);

      expect(tone.key).not.toBeNull();
      expect(TABLES.pt[tone.key!]).toBeDefined();
      expect(TABLES.en[tone.key!]).toBeDefined();
    }
  });

  /**
   * A status from a future migration keeps its machine code on screen rather
   * than becoming a blank or a wrong word — the same choice `translateWith`
   * makes for a missing key.
   */
  it('leaves an unknown status untranslated rather than guessing', () => {
    expect(campaignStatusTone('QUARANTINED').key).toBeNull();
    expect(campaignStatusTone(null).key).toBeNull();
  });
});
