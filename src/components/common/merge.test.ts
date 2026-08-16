import { describe, expect, it } from 'vitest';

import type { MessageProjection } from '../../domain/feed/projection';
import { mergeMessages, settleOptimisticMessages } from './merge';

const message = (overrides: Partial<MessageProjection>): MessageProjection =>
  ({
    id: 'm',
    wamid: null,
    direction: 'OUTBOUND',
    type: 'TEXT',
    status: 'QUEUED',
    body: null,
    waTimestamp: null,
    createdAt: '2026-08-16T10:00:00.000Z',
    statusTimestamps: {},
    errorCode: null,
    errorDetail: null,
    retryCount: 0,
    isRetryable: false,
    lane: null,
    sourceKind: null,
    templateName: null,
    templateLanguage: null,
    templateCategory: null,
    contextWamid: null,
    reactionTargetWamid: null,
    media: null,
    reactions: [],
    payload: null,
    clientToken: null,
    sentById: null,
    threadId: 't1',
    ...overrides,
  }) as MessageProjection;

/**
 * The merge is where a polling chat gets duplicated or reordered, and both are
 * the kind of bug a rep reports as "it's weird" rather than as a defect.
 */
describe('mergeMessages', () => {
  it('replaces the optimistic bubble with the server’s record of the same send', () => {
    const optimistic = message({
      id: 'local-1',
      clientToken: 'tok-1',
      status: 'QUEUED',
      body: 'olá',
    });
    const confirmed = message({
      id: 'server-1',
      clientToken: 'tok-1',
      status: 'ACCEPTED',
      wamid: 'wamid.X',
      body: 'olá',
    });

    const merged = mergeMessages([optimistic], [confirmed]);

    // One bubble, not two — the rep sent one message.
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'server-1', status: 'ACCEPTED' });
  });

  it('replaces a message in place when only its status advanced', () => {
    const sent = message({ id: 'm1', status: 'SENT' });
    const delivered = message({ id: 'm1', status: 'DELIVERED' });

    const merged = mergeMessages([sent], [delivered]);

    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('DELIVERED');
  });

  it('keeps the list newest-first when a new message arrives', () => {
    const older = message({ id: 'm1', createdAt: '2026-08-16T10:00:00.000Z' });
    const newer = message({ id: 'm2', createdAt: '2026-08-16T11:00:00.000Z' });

    expect(mergeMessages([older], [newer]).map((row) => row.id)).toEqual(['m2', 'm1']);
  });

  it('re-sorts a delta that arrived out of order', () => {
    const first = message({ id: 'm1', createdAt: '2026-08-16T10:00:00.000Z' });
    const second = message({ id: 'm2', createdAt: '2026-08-16T12:00:00.000Z' });
    const third = message({ id: 'm3', createdAt: '2026-08-16T11:00:00.000Z' });

    const merged = mergeMessages([first], [second, third]);

    expect(merged.map((row) => row.id)).toEqual(['m2', 'm3', 'm1']);
  });

  it('appends an older page without disturbing what is on screen', () => {
    const onScreen = [
      message({ id: 'm3', createdAt: '2026-08-16T12:00:00.000Z' }),
      message({ id: 'm2', createdAt: '2026-08-16T11:00:00.000Z' }),
    ];
    const older = [
      message({ id: 'm1', createdAt: '2026-08-16T10:00:00.000Z' }),
      message({ id: 'm0', createdAt: '2026-08-16T09:00:00.000Z' }),
    ];

    expect(mergeMessages(onScreen, older, { append: true }).map((row) => row.id)).toEqual([
      'm3',
      'm2',
      'm1',
      'm0',
    ]);
  });

  it('returns the same array when there is nothing to merge', () => {
    const existing = [message({ id: 'm1' })];

    // Identity, so React does not re-render a 200-row list to say nothing
    // happened — which is every poll, most of the time.
    expect(mergeMessages(existing, [])).toBe(existing);
  });

  it('does not confuse two different sends that both lack a token', () => {
    const one = message({ id: 'm1', clientToken: null });
    const two = message({ id: 'm2', clientToken: null });

    expect(mergeMessages([one], [two])).toHaveLength(2);
  });
});

/**
 * The bubble that outlives the send.
 *
 * A refusal creates no server row, so nothing a later poll returns replaces the
 * optimistic message — it sat in the conversation saying "queued" for as long
 * as the tab stayed open, describing a message that was never sent.
 */
describe('settleOptimisticMessages', () => {
  it('marks the refused bubble failed and puts the reason on it', () => {
    const settled = settleOptimisticMessages(
      [message({ id: 'local-tok', clientToken: 'tok', body: 'Olá' })],
      'tok',
      { error: 'The 24-hour window has closed.' },
    );

    expect(settled[0]).toMatchObject({
      status: 'FAILED',
      errorDetail: 'The 24-hour window has closed.',
      isRetryable: true,
    });
  });

  it('leaves every other message alone', () => {
    const settled = settleOptimisticMessages(
      [
        message({ id: 'local-a', clientToken: 'a', body: 'mine' }),
        message({ id: 'local-b', clientToken: 'b', body: 'someone else', status: 'QUEUED' }),
      ],
      'a',
      { error: 'nope' },
    );

    expect(settled[1]).toMatchObject({ status: 'QUEUED', errorDetail: null });
  });

  /**
   * The race that matters: the send failed *after* a poll already brought back
   * the server's row for the same token. The server knows what happened; a late
   * client-side error must not overwrite it.
   */
  it('never overwrites a server row that already arrived for the same token', () => {
    const settled = settleOptimisticMessages(
      [message({ id: 'srv-1', clientToken: 'tok', status: 'SENT', body: 'Olá' })],
      'tok',
      { error: 'timeout' },
    );

    expect(settled[0]).toMatchObject({ status: 'SENT', errorDetail: null });
  });

  /** Nothing to retry when there is no text — a template needs its parameters again. */
  it('does not offer retry for a bubble with no body', () => {
    const settled = settleOptimisticMessages(
      [message({ id: 'local-t', clientToken: 't', body: null, templateName: 'convite' })],
      't',
      { error: 'nope' },
    );

    expect(settled[0]?.isRetryable).toBe(false);
  });
});
