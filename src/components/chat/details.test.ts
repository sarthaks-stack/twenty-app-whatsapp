import { describe, expect, it } from 'vitest';

import { projectMessage, type MessageProjection } from '../../domain/feed/projection';
import { isCopyKey, messageDetails } from './details';

const message = (overrides: Record<string, unknown>): MessageProjection =>
  projectMessage({ id: 'm1', ...overrides });

/**
 * The panel's job changed with the renderer registry.
 *
 * It used to lift an address or a phone number out of the payload, because the
 * bubble showed neither. The bubble shows both now, and the spec is explicit
 * that no location or contact should need "Show details" to be understandable —
 * so what is left here is the delivery story, and the ids an automation keys
 * off. Never the raw webhook object, which is what it showed before either
 * version of this file existed.
 */
describe('messageDetails', () => {
  it('tells the delivery story in the order it happened', () => {
    expect(
      messageDetails(
        message({
          messageType: 'TEXT',
          direction: 'OUTBOUND',
          statusTimestamps: {
            read: 1_786_809_900,
            accepted: 1_786_809_498,
            delivered: 1_786_809_700,
          },
        }),
        () => 'HH:MM',
      ),
    ).toEqual([
      { key: 'chat.detail.type', value: 'chat.type.TEXT' },
      { key: 'chat.detail.accepted', value: 'HH:MM' },
      { key: 'chat.detail.delivered', value: 'HH:MM' },
      { key: 'chat.detail.read', value: 'HH:MM' },
    ]);
  });

  /**
   * Epoch *seconds*, which is what Meta sends. Reading them as milliseconds
   * dates every message to January 1970 — a unit bug that looks like a
   * formatting one.
   */
  it('reads the stored timestamps as seconds', () => {
    const rows = messageDetails(
      message({ messageType: 'TEXT', statusTimestamps: { sent: 1_786_809_498 } }),
      (iso) => iso,
    );

    expect(rows).toContainEqual({
      key: 'chat.detail.sent',
      value: new Date(1_786_809_498_000).toISOString(),
    });
  });

  it('shows the id behind a quick reply, which is the one thing the bubble cannot', () => {
    expect(
      messageDetails(
        message({
          messageType: 'BUTTON_REPLY',
          body: 'Sim',
          payload: { id: 'btn_yes', title: 'Sim' },
        }),
      ),
    ).toContainEqual({ key: 'chat.detail.buttonId', value: 'btn_yes' });

    expect(
      messageDetails(
        message({
          messageType: 'LIST_REPLY',
          payload: { id: 'row_b', title: 'Opção B', description: 'Entrega em 48h' },
        }),
      ),
    ).toContainEqual({ key: 'chat.detail.rowId', value: 'row_b' });
  });

  /**
   * The description is in the bubble now. Repeating it here would make the
   * panel a second, worse copy of the message.
   */
  it('does not repeat what the renderer already shows', () => {
    const rows = messageDetails(
      message({
        messageType: 'LIST_REPLY',
        payload: { id: 'row_b', title: 'Opção B', description: 'Entrega em 48h' },
      }),
    );

    expect(rows.map((row) => row.value)).not.toContain('Entrega em 48h');
  });

  it('names the file and its size for an attachment', () => {
    expect(
      messageDetails(
        message({
          messageType: 'DOCUMENT',
          mediaMeta: { filename: 'Proposta.pdf', fileSize: 82_000 },
        }),
      ),
    ).toEqual([
      { key: 'chat.detail.type', value: 'chat.type.DOCUMENT' },
      { key: 'chat.detail.file', value: 'Proposta.pdf' },
      { key: 'chat.detail.size', value: '80 kB' },
    ]);
  });

  it('names the template’s language and category, which the bubble does not', () => {
    const rows = messageDetails(
      message({
        messageType: 'TEMPLATE',
        templateName: 'boas_vindas',
        templateLanguage: 'pt_PT',
        templateCategory: 'UTILITY',
      }),
    );

    expect(rows).toContainEqual({ key: 'chat.detail.template', value: 'boas_vindas' });
    expect(rows).toContainEqual({ key: 'chat.detail.language', value: 'pt_PT' });
  });

  it('attributes reactions, which the chips can only do in a hover label', () => {
    expect(
      messageDetails(
        message({
          messageType: 'TEXT',
          payload: {
            reactions: [{ waId: '244900000001', actorLabel: 'Marcos', emoji: '👍' }],
          },
        }),
      ),
    ).toContainEqual({ key: 'chat.detail.reactions', value: '👍 Marcos' });
  });

  it('counts attempts only when there were any', () => {
    expect(
      messageDetails(message({ messageType: 'TEXT', retryCount: 2 })),
    ).toContainEqual({ key: 'chat.detail.attempts', value: '2' });

    expect(
      messageDetails(message({ messageType: 'TEXT', retryCount: 0 })).map((row) => row.key),
    ).not.toContain('chat.detail.attempts');
  });
});

describe('isCopyKey', () => {
  /**
   * The type row's value is itself a copy key and must be translated; a
   * filename must not. Translating everything would render `Proposta.pdf` as
   * the literal string `Proposta.pdf` — harmless — and translating nothing
   * would show a rep the raw key `chat.type.IMAGE`, which is not.
   */
  it('separates a translatable value from data', () => {
    expect(isCopyKey('chat.type.IMAGE')).toBe(true);
    expect(isCopyKey('Proposta.pdf')).toBe(false);
  });
});
