import { describe, expect, it } from 'vitest';

import { nextTabKey, tabPanelId } from './ui';

const KEYS = ['connection', 'health', 'templates', 'variables', 'diagnostics'];

/**
 * `role="tab"` is a promise about the keyboard. The tab strip carried the role
 * and `aria-selected` without any of the behaviour, which is worse than plain
 * buttons: a screen reader announces "tab, 2 of 5" and then the arrow keys do
 * nothing at all.
 */
describe('nextTabKey', () => {
  it('moves forward and backward', () => {
    expect(nextTabKey(KEYS, 'health', 'ArrowRight')).toBe('templates');
    expect(nextTabKey(KEYS, 'health', 'ArrowLeft')).toBe('connection');
  });

  /** Vertical arrows are part of the model too; a tab strip may be laid out either way. */
  it('treats up/down like left/right', () => {
    expect(nextTabKey(KEYS, 'health', 'ArrowDown')).toBe('templates');
    expect(nextTabKey(KEYS, 'health', 'ArrowUp')).toBe('connection');
  });

  /**
   * Wrapping at both ends. Without it the last tab is a dead end in one
   * direction, and Home/End become the only way out.
   */
  it('wraps at both ends', () => {
    expect(nextTabKey(KEYS, 'diagnostics', 'ArrowRight')).toBe('connection');
    expect(nextTabKey(KEYS, 'connection', 'ArrowLeft')).toBe('diagnostics');
  });

  it('jumps to the ends on Home and End', () => {
    expect(nextTabKey(KEYS, 'templates', 'Home')).toBe('connection');
    expect(nextTabKey(KEYS, 'templates', 'End')).toBe('diagnostics');
  });

  /**
   * Everything else must return null so the handler can leave the event alone.
   * Swallowing Tab or Enter here would trap focus in the strip.
   */
  it('ignores every other key', () => {
    for (const press of ['Tab', 'Enter', ' ', 'a', 'Escape', 'PageDown']) {
      expect(nextTabKey(KEYS, 'health', press)).toBeNull();
    }
  });

  it('starts from the first tab when the active key is not in the list', () => {
    expect(nextTabKey(KEYS, 'gone', 'ArrowRight')).toBe('health');
  });

  it('answers null for an empty strip rather than throwing', () => {
    expect(nextTabKey([], 'health', 'ArrowRight')).toBeNull();
  });
});

/**
 * The app settings screen has Twenty's own tab strip above ours. Both would
 * claim `wa-tab-health` without the namespace, and duplicate ids break exactly
 * the assistive technology the roles are there for.
 */
describe('tabPanelId', () => {
  it('namespaces the panel id by group', () => {
    expect(tabPanelId('settings', 'health')).toBe('wa-tab-settings-health');
    expect(tabPanelId('campaigns', 'health')).not.toBe(tabPanelId('settings', 'health'));
  });
});
