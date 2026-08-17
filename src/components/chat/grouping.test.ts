import { describe, expect, it } from 'vitest';

import { projectMessage, type MessageProjection } from '../../domain/feed/projection';
import { GROUP_WINDOW_MS, groupMessages, sameTurn } from './grouping';

/**
 * The array is newest-first, because the transcript renders into a
 * `column-reverse` container. Every test below is written in that order on
 * purpose: reading it the other way is the mistake this module exists to make
 * impossible, and it puts every timestamp on the wrong bubble.
 */

const at = (minutes: number): string =>
  new Date(Date.parse('2026-08-17T10:00:00Z') + minutes * 60_000).toISOString();

const message = (
  id: string,
  overrides: Record<string, unknown> = {},
): MessageProjection =>
  projectMessage({
    id,
    messageType: 'TEXT',
    direction: 'OUTBOUND',
    sourceKind: 'AGENT',
    lane: 'INTERACTIVE',
    ...overrides,
  });

describe('sameTurn', () => {
  it('groups two messages from one sender inside the window', () => {
    expect(
      sameTurn(
        message('b', { waTimestamp: at(3) }),
        message('a', { waTimestamp: at(0) }),
      ),
    ).toBe(true);
  });

  it('breaks the group once the pause is longer than the window', () => {
    expect(
      sameTurn(
        message('b', { waTimestamp: at(GROUP_WINDOW_MS / 60_000 + 1) }),
        message('a', { waTimestamp: at(0) }),
      ),
    ).toBe(false);
  });

  it('never groups across directions', () => {
    expect(
      sameTurn(
        message('b', { direction: 'INBOUND', waTimestamp: at(1) }),
        message('a', { direction: 'OUTBOUND', waTimestamp: at(0) }),
      ),
    ).toBe(false);
  });

  /**
   * The half that matters in a busy workspace. Two reps answering the same
   * conversation within a minute are two people, and merging them under one
   * heading attributes one rep's words to the other.
   */
  it('never groups two different reps, or a rep with an automation', () => {
    expect(
      sameTurn(
        message('b', { sentById: 'wm-2', waTimestamp: at(1) }),
        message('a', { sentById: 'wm-1', waTimestamp: at(0) }),
      ),
    ).toBe(false);

    expect(
      sameTurn(
        message('b', { sourceKind: 'WORKFLOW', waTimestamp: at(1) }),
        message('a', { sourceKind: 'AGENT', waTimestamp: at(0) }),
      ),
    ).toBe(false);
  });

  /**
   * A failure's error sentence is the most important line in the conversation,
   * and a grouped failure would inherit the group's silence — losing the one
   * timestamp that says *when* it failed.
   */
  it('never groups a failed message', () => {
    expect(
      sameTurn(
        message('b', { status: 'FAILED', waTimestamp: at(1) }),
        message('a', { status: 'SENT', waTimestamp: at(0) }),
      ),
    ).toBe(false);
  });

  it('opens a new group for a quoted reply, whose strip is its heading', () => {
    const newer = {
      ...message('b', { waTimestamp: at(1) }),
      quote: {
        wamid: 'w1',
        direction: 'INBOUND' as const,
        senderLabel: null,
        type: 'TEXT',
        preview: 'Bom dia',
        thumbnailUrl: null,
      },
    };

    expect(sameTurn(newer, message('a', { waTimestamp: at(0) }))).toBe(false);
  });

  /** A clock that ran backwards is not a group; it is a data problem. */
  it('refuses a negative gap rather than grouping on its absolute value', () => {
    expect(
      sameTurn(
        message('b', { waTimestamp: at(0) }),
        message('a', { waTimestamp: at(3) }),
      ),
    ).toBe(false);
  });
});

describe('groupMessages', () => {
  it('marks the oldest of a run as its start and the newest as its end', () => {
    const messages = [
      message('c', { waTimestamp: at(4) }),
      message('b', { waTimestamp: at(2) }),
      message('a', { waTimestamp: at(0) }),
    ];

    const flags = groupMessages(messages);

    expect(flags.get('a')).toEqual({ startsGroup: true, endsGroup: false });
    expect(flags.get('b')).toEqual({ startsGroup: false, endsGroup: false });
    // Newest: carries the time and the delivery ticks.
    expect(flags.get('c')).toEqual({ startsGroup: false, endsGroup: true });
  });

  it('gives a lone message both flags', () => {
    expect(groupMessages([message('a', { waTimestamp: at(0) })]).get('a')).toEqual({
      startsGroup: true,
      endsGroup: true,
    });
  });

  /**
   * A day boundary breaks a group even inside five minutes: 23:58 and 00:01 are
   * three minutes apart and belong to different days on screen, so a group
   * spanning the separator would put its heading on the wrong side of it.
   */
  it('breaks a group at a day separator', () => {
    const messages = [
      message('b', { waTimestamp: at(3) }),
      message('a', { waTimestamp: at(0) }),
    ];

    const flags = groupMessages(messages, new Set(['b']));

    expect(flags.get('b')?.startsGroup).toBe(true);
    expect(flags.get('a')?.endsGroup).toBe(true);
  });

  it('handles a message with no usable timestamp without grouping it wrongly', () => {
    const flags = groupMessages([
      message('b', { waTimestamp: null, createdAt: null }),
      message('a', { waTimestamp: at(0) }),
    ]);

    // An unknown stamp reads as epoch zero, so the gap is negative and the two
    // stay apart — the safe direction, since a wrong group misattributes.
    expect(flags.get('b')?.startsGroup).toBe(true);
  });
});
