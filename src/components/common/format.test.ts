import { describe, expect, it } from 'vitest';

import { translateWith } from './copy';
import { clockTime, countdown, dayKey, daySeparator, fileSize } from './format';

const t = translateWith('pt');

/**
 * Africa/Luanda is UTC+1 with no daylight saving, so 23:30 UTC is already
 * tomorrow for the customer. Every assertion below is about that hour.
 */
describe('day boundaries', () => {
  it('files a late-evening message under the customer’s day, not UTC’s', () => {
    // 23:30Z on the 16th is 00:30 on the 17th in Luanda.
    expect(dayKey('2026-08-16T23:30:00.000Z')).toBe('2026-08-17');
    expect(dayKey('2026-08-16T22:30:00.000Z')).toBe('2026-08-16');
  });

  it('calls the customer’s today today', () => {
    const now = new Date('2026-08-17T09:00:00.000Z');

    expect(daySeparator('2026-08-16T23:30:00.000Z', now, 'pt', t)).toBe('Hoje');
  });

  it('calls the day before yesterday', () => {
    const now = new Date('2026-08-17T09:00:00.000Z');

    expect(daySeparator('2026-08-16T12:00:00.000Z', now, 'pt', t)).toBe('Ontem');
  });

  it('shows the clock in Luanda, not in the reader’s zone', () => {
    expect(clockTime('2026-08-16T23:30:00.000Z', 'pt')).toBe('00:30');
  });
});

describe('countdown', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');

  it('reads hours and minutes while there is time', () => {
    expect(countdown('2026-08-16T17:12:00.000Z', now)).toBe('5h 12m');
  });

  it('drops to minutes inside the last hour', () => {
    expect(countdown('2026-08-16T12:45:00.000Z', now)).toBe('45m');
  });

  it('never rounds a nearly-closed window up to a minute', () => {
    // Rounding "59 seconds left" to "1m" is how a rep types a free-form reply
    // into a window that closes while they are typing.
    expect(countdown('2026-08-16T12:00:59.000Z', now)).toBe('<1m');
  });

  it('answers null once the window has closed, so no chip is drawn', () => {
    expect(countdown('2026-08-16T11:59:59.000Z', now)).toBeNull();
    expect(countdown(null, now)).toBeNull();
  });
});

describe('fileSize', () => {
  it('reads the way a download button should', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(51_200)).toBe('50 kB');
    expect(fileSize(94_371_840)).toBe('90 MB');
    expect(fileSize(1_572_864)).toBe('1.5 MB');
  });

  it('says nothing rather than "NaN" for a size nobody recorded', () => {
    expect(fileSize(null)).toBe('');
    expect(fileSize(undefined)).toBe('');
  });
});

describe('copy', () => {
  it('renders a missing key visibly rather than as silence', () => {
    // A blank denial reads as "you may send".
    expect(t('policy.NOT_A_REAL_CODE')).toBe('policy.NOT_A_REAL_CODE');
  });

  it('falls back to Portuguese for a key not yet translated', () => {
    expect(translateWith('en')('policy.WINDOW_CLOSED')).toContain('window');
  });

  it('substitutes values', () => {
    expect(t('chat.closesIn', { time: '5h 12m' })).toBe('fecha em 5h 12m');
  });
});
