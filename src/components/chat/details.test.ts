import { describe, expect, it } from 'vitest';

import { projectMessage, type MessageProjection } from '../../domain/feed/projection';
import { messageDetails } from './details';

const message = (
  messageType: string,
  payload: Record<string, unknown> | null,
): MessageProjection => projectMessage({ id: 'm1', messageType, payload });

/**
 * The bubble used to answer "Ver detalhes" with the raw webhook object. What
 * replaces it must show the handful of things the body genuinely drops — and,
 * just as importantly, must show *nothing* for the many types where the body
 * already says everything, so those bubbles lose the button entirely.
 */
describe('messageDetails', () => {
  it('gives a location its address and coordinates', () => {
    expect(
      messageDetails(
        message('LOCATION', {
          latitude: -8.83,
          longitude: 13.23,
          name: 'Mercado',
          address: 'Rua Rainha Ginga 12',
        }),
      ),
    ).toEqual([
      { key: 'chat.detail.address', value: 'Rua Rainha Ginga 12' },
      { key: 'chat.detail.coordinates', value: '-8.83, 13.23' },
    ]);
  });

  it('omits the coordinates when only one half arrived', () => {
    expect(messageDetails(message('LOCATION', { latitude: -8.83 }))).toEqual([]);
  });

  it('flattens a shared contact card to name and number', () => {
    expect(
      messageDetails(
        message('CONTACTS', {
          contacts: [
            {
              name: { formatted_name: 'Ana Paula' },
              phones: [{ phone: '+244 923 456 789' }],
            },
          ],
        }),
      ),
    ).toEqual([{ key: 'chat.detail.contact', value: 'Ana Paula · +244 923 456 789' }]);
  });

  it('still shows a contact card that has only a name', () => {
    expect(
      messageDetails(message('CONTACTS', { contacts: [{ name: { first_name: 'Ana' } }] })),
    ).toEqual([{ key: 'chat.detail.contact', value: 'Ana' }]);
  });

  it('drops a contact entry that carries neither a name nor a number', () => {
    expect(messageDetails(message('CONTACTS', { contacts: [{}, null] }))).toEqual([]);
  });

  it('gives a list reply its second line', () => {
    expect(
      messageDetails(
        message('LIST_REPLY', { id: 'x', title: 'Entrega', description: 'Chega amanhã' }),
      ),
    ).toEqual([{ key: 'chat.detail.description', value: 'Chega amanhã' }]);
  });

  /**
   * The whole point. A button reply's payload is `{id, title}` and the bubble
   * already prints the title — there is nothing left to reveal, so no button.
   */
  it('has nothing to add for the types whose body already says it', () => {
    expect(messageDetails(message('BUTTON_REPLY', { id: 'x', title: 'Sim' }))).toEqual([]);
    expect(messageDetails(message('TEXT', { body: 'olá' }))).toEqual([]);
    expect(messageDetails(message('SYSTEM', { body: 'number changed' }))).toEqual([]);
  });

  it('answers nothing at all for a message with no payload', () => {
    expect(messageDetails(message('LOCATION', null))).toEqual([]);
  });
});
