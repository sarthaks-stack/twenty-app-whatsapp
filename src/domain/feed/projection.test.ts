import { describe, expect, it } from 'vitest';

import { isRetryableError, projectMessage, projectThread } from './projection';

/**
 * What the components are allowed to believe.
 *
 * `isRetryable` is the one field here that is a *decision* rather than a copy,
 * which is why it is tested hardest: the **Repetir** button appears because of
 * it, and a button that appears on a message that can never succeed teaches a
 * rep to press it on the ones that can't either.
 */
describe('isRetryableError', () => {
  it('offers a retry only for the backoff class', () => {
    // 130429 — rate limit hit. Waiting is exactly the fix.
    expect(isRetryableError('130429')).toBe(true);
  });

  it('refuses a retry for a terminal recipient outcome', () => {
    // 131026 — not on WhatsApp. No number of presses changes that.
    expect(isRetryableError('131026')).toBe(false);
  });

  it('refuses a retry for an internal policy code', () => {
    expect(isRetryableError('POLICY_WINDOW_CLOSED')).toBe(false);
    expect(isRetryableError('UNKNOWN_ACCEPTANCE')).toBe(false);
  });

  it('refuses a retry for a code with no catalogue row', () => {
    // Absence of evidence that a retry is safe is not evidence that it is.
    expect(isRetryableError('999999')).toBe(false);
  });

  it('answers false for a message that never failed', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError('')).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe('projectMessage', () => {
  it('carries the signed file url the bubble renders from', () => {
    const projected = projectMessage({
      id: 'm1',
      messageType: 'IMAGE',
      mediaMeta: { mimeType: 'image/jpeg', fileSize: 51_200, deferred: false },
      mediaFile: [{ fileId: 'f1', label: 'photo.jpg', url: 'https://host/file/f1?token=x' }],
    });

    expect(projected.media).toEqual({
      kind: 'IMAGE',
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
      sizeBytes: 51_200,
      url: 'https://host/file/f1?token=x',
      deferred: false,
      downloadFailed: false,
    });
  });

  it('reports deferred media with no url, so the bubble offers a download (D-8)', () => {
    const projected = projectMessage({
      id: 'm1',
      messageType: 'VIDEO',
      mediaMeta: { fileSize: 94_371_840, deferred: true },
    });

    expect(projected.media).toMatchObject({ deferred: true, url: null, sizeBytes: 94_371_840 });
  });

  it('has no media block at all for a text message', () => {
    expect(projectMessage({ id: 'm1', messageType: 'TEXT', body: 'olá' }).media).toBeNull();
  });

  it('lifts reactions out of the payload and drops cleared ones', () => {
    const projected = projectMessage({
      id: 'm1',
      payload: {
        reactions: [
          { waId: '244900000001', emoji: '👍' },
          // A cleared reaction is stored as an empty emoji; showing it would
          // render a blank chip that a rep cannot explain.
          { waId: '244900000002', emoji: '' },
        ],
      },
    });

    expect(projected.reactions).toEqual([{ waId: '244900000001', emoji: '👍' }]);
  });

  it('parses a JSON column that arrived as a string', () => {
    const projected = projectMessage({
      id: 'm1',
      statusTimestamps: '{"accepted":1786884204}',
    });

    expect(projected.statusTimestamps).toEqual({ accepted: 1786884204 });
  });

  it('survives a payload that is not JSON at all', () => {
    const projected = projectMessage({ id: 'm1', payload: 'not json {' });

    expect(projected.payload).toBeNull();
    expect(projected.reactions).toEqual([]);
  });
});

describe('projectThread', () => {
  it('normalises the counters a badge reads, so the UI never renders null', () => {
    const projected = projectThread({ id: 't1' });

    expect(projected.unreadCount).toBe(0);
    expect(projected.isBlocked).toBe(false);
    expect(projected.person).toBeNull();
  });

  it('keeps the link candidates that ask a human to decide (FR-CID-5)', () => {
    const projected = projectThread({
      id: 't1',
      status: 'NEEDS_REVIEW',
      linkCandidates: { candidates: [{ personId: 'p1' }, { personId: 'p2' }] },
    });

    expect(projected.linkCandidates).toEqual({
      candidates: [{ personId: 'p1' }, { personId: 'p2' }],
    });
  });
});
