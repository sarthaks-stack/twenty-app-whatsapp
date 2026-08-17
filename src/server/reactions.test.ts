import { describe, expect, it } from 'vitest';

import { applyReactionToList, type ReactionActor } from './reactions';

const CONTACT: ReactionActor = { kind: 'CONTACT', waId: '244900000001', label: 'Marcos' };
const OTHER_CONTACT: ReactionActor = { kind: 'CONTACT', waId: '244900000002' };
const REP: ReactionActor = { kind: 'WORKSPACE_MEMBER', workspaceMemberId: 'wm-1' };
const OTHER_REP: ReactionActor = { kind: 'WORKSPACE_MEMBER', workspaceMemberId: 'wm-2' };

describe('applyReactionToList', () => {
  it('adds a reaction to a message that had none', () => {
    expect(applyReactionToList(undefined, CONTACT, '👍')).toEqual([
      { waId: '244900000001', actorLabel: 'Marcos', emoji: '👍' },
    ]);
  });

  /**
   * WhatsApp lets anyone change their reaction. Appending would show one person
   * reacting three times with three different emoji.
   */
  it('replaces an actor’s own reaction rather than appending a second', () => {
    const first = applyReactionToList([], CONTACT, '👍');
    const second = applyReactionToList(first, CONTACT, '❤️');

    expect(second).toEqual([
      { waId: '244900000001', actorLabel: 'Marcos', emoji: '❤️' },
    ]);
  });

  it('removes the reaction when the emoji is empty — the same call, not a delete', () => {
    const existing = applyReactionToList([], CONTACT, '👍');

    expect(applyReactionToList(existing, CONTACT, '')).toEqual([]);
  });

  it('leaves everyone else’s reaction alone', () => {
    const list = [
      ...applyReactionToList([], CONTACT, '👍'),
      ...applyReactionToList([], OTHER_CONTACT, '😮'),
    ];

    expect(applyReactionToList(list, CONTACT, '')).toEqual([
      { waId: '244900000002', emoji: '😮' },
    ]);
  });

  /**
   * A rep and a contact are different actors even though both end up in one
   * array. Matching on `waId` alone would let a rep's reaction clear a
   * customer's, because a rep has no `waId` at all and every missing one is
   * `undefined`.
   */
  it('never confuses a rep with a contact, or one rep with another', () => {
    const list = [
      ...applyReactionToList([], CONTACT, '👍'),
      ...applyReactionToList([], REP, '🙏'),
    ];

    const withOtherRep = applyReactionToList(list, OTHER_REP, '😂');

    expect(withOtherRep).toHaveLength(3);
    expect(applyReactionToList(withOtherRep, REP, '')).toEqual([
      { waId: '244900000001', actorLabel: 'Marcos', emoji: '👍' },
      { workspaceMemberId: 'wm-2', emoji: '😂' },
    ]);
  });

  it('survives a payload whose reactions field is not an array', () => {
    expect(applyReactionToList('corrupted', REP, '👍')).toEqual([
      { workspaceMemberId: 'wm-1', emoji: '👍' },
    ]);
  });
});
