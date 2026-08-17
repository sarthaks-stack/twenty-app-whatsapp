import { describe, expect, it } from 'vitest';

import { projectContent, projectInteractive, type ContentSource } from './content';
import { EMPTY_MEDIA, documentFamily, effectiveKind } from './media';

/**
 * The registry key, and the cases the old `MessageBubble` conditionals got
 * wrong. Every test below is one of the spec's "what still feels immature"
 * findings, expressed as the projection that makes the finding impossible.
 */

const source = (overrides: Partial<ContentSource>): ContentSource => ({
  type: 'TEXT',
  direction: 'INBOUND',
  body: null,
  payload: null,
  media: null,
  templateName: null,
  templateLanguage: null,
  templateCategory: null,
  reactionTargetWamid: null,
  ...overrides,
});

describe('projectContent', () => {
  it('reads a location as a place, not as a pair of numbers', () => {
    const content = projectContent(
      source({
        type: 'LOCATION',
        body: 'Talatona Office',
        payload: {
          latitude: -8.9126,
          longitude: 13.2334,
          name: 'Talatona Office',
          address: 'Rua Centro, Luanda',
        },
      }),
    );

    expect(content).toEqual({
      kind: 'location',
      name: 'Talatona Office',
      address: 'Rua Centro, Luanda',
      latitude: -8.9126,
      longitude: 13.2334,
    });
  });

  /** Meta sends the coordinates as strings often enough to matter. */
  it('accepts numeric coordinates that arrived as strings', () => {
    const content = projectContent(
      source({ type: 'LOCATION', payload: { latitude: '-8.9126', longitude: '13.2334' } }),
    );

    expect(content).toMatchObject({ latitude: -8.9126, longitude: 13.2334 });
  });

  it('reads a shared contact as a card with its numbers, not as a name', () => {
    const content = projectContent(
      source({
        type: 'CONTACTS',
        body: 'Abel Febere',
        payload: {
          contacts: [
            {
              name: { formatted_name: 'Abel Febere', first_name: 'Abel' },
              org: { company: 'Pixel', title: 'Director' },
              phones: [{ phone: '+244 923 000 000', wa_id: '244923000000', type: 'CELL' }],
              emails: [{ email: 'abel@pixel.ao', type: 'WORK' }],
            },
          ],
        },
      }),
    );

    expect(content).toEqual({
      kind: 'contacts',
      contacts: [
        {
          formattedName: 'Abel Febere',
          firstName: 'Abel',
          lastName: null,
          organization: 'Pixel',
          title: 'Director',
          phones: [{ phone: '+244 923 000 000', waId: '244923000000', type: 'CELL' }],
          emails: [{ email: 'abel@pixel.ao', type: 'WORK' }],
        },
      ],
    });
  });

  it('drops a contact card with nothing on it rather than rendering a blank', () => {
    const content = projectContent(
      source({ type: 'CONTACTS', payload: { contacts: [{}, { name: {} }] } }),
    );

    expect(content).toEqual({ kind: 'contacts', contacts: [] });
  });

  /**
   * The spec's fifth finding: "Sim" tapped as a quick reply and "Sim" typed
   * into the box are the same three characters and different facts.
   */
  it('separates a quick-reply tap from a typed message', () => {
    expect(
      projectContent(
        source({ type: 'BUTTON_REPLY', body: 'Sim', payload: { id: 'btn_yes', title: 'Sim' } }),
      ),
    ).toEqual({
      kind: 'interactiveReply',
      reply: { kind: 'button', id: 'btn_yes', title: 'Sim', description: null, fields: [] },
    });

    expect(projectContent(source({ type: 'TEXT', body: 'Sim' }))).toEqual({
      kind: 'text',
      body: 'Sim',
    });
  });

  /** A template quick-reply arrives as `{payload, text}`, not `{id, title}`. */
  it('reads a template button tap through its other wire shape', () => {
    expect(
      projectContent(
        source({
          type: 'BUTTON_REPLY',
          body: 'Confirmar',
          payload: { payload: 'CONFIRM', text: 'Confirmar' },
        }),
      ),
    ).toMatchObject({ reply: { id: 'CONFIRM', title: 'Confirmar' } });
  });

  it('keeps the description a list reply carries and the bubble used to drop', () => {
    expect(
      projectContent(
        source({
          type: 'LIST_REPLY',
          body: 'Opção B',
          payload: { id: 'row_b', title: 'Opção B', description: 'Entrega em 48h' },
        }),
      ),
    ).toMatchObject({
      reply: { kind: 'list', id: 'row_b', description: 'Entrega em 48h' },
    });
  });

  /**
   * The one type whose direction changes its meaning: outbound is a message we
   * composed, inbound is a Flow answer.
   */
  it('reads an outbound interactive message as the buttons the customer saw', () => {
    const content = projectContent(
      source({
        type: 'INTERACTIVE',
        direction: 'OUTBOUND',
        payload: {
          kind: 'interactive',
          interactive: {
            type: 'button',
            header: { type: 'text', text: 'Entrega' },
            body: { text: 'Confirma a morada?' },
            footer: { text: 'Pixel' },
            action: {
              buttons: [
                { type: 'reply', reply: { id: 'btn_yes', title: 'Sim' } },
                { type: 'reply', reply: { id: 'btn_no', title: 'Não' } },
              ],
            },
          },
        },
      }),
    );

    expect(content).toEqual({
      kind: 'interactive',
      interactive: {
        kind: 'buttons',
        header: 'Entrega',
        body: 'Confirma a morada?',
        footer: 'Pixel',
        buttons: [
          { id: 'btn_yes', title: 'Sim' },
          { id: 'btn_no', title: 'Não' },
        ],
      },
    });
  });

  it('reads an inbound flow response as an answer with its fields', () => {
    const content = projectContent(
      source({
        type: 'INTERACTIVE',
        direction: 'INBOUND',
        body: 'Resposta interactiva (nfm_reply)',
        payload: {
          type: 'nfm_reply',
          nfm_reply: {
            body: 'Enviado',
            response_json: JSON.stringify({
              flow_token: 'secret-token',
              size: 'M',
              quantity: 2,
              nested: { ignored: true },
            }),
          },
        },
      }),
    );

    expect(content).toMatchObject({
      kind: 'interactiveReply',
      reply: {
        kind: 'flow',
        // The flow token is a credential, not an answer, and never renders.
        fields: [
          { key: 'size', value: 'M' },
          { key: 'quantity', value: '2' },
        ],
      },
    });
  });

  it('does not print a document’s filename twice', () => {
    const media = { ...EMPTY_MEDIA, kind: 'DOCUMENT', fileName: 'Proposta.pdf' };

    expect(
      projectContent(source({ type: 'DOCUMENT', body: 'Proposta.pdf', media })),
    ).toEqual({ kind: 'document', media, caption: null });

    expect(
      projectContent(source({ type: 'DOCUMENT', body: 'Veja em anexo', media })),
    ).toEqual({ kind: 'document', media, caption: 'Veja em anexo' });
  });

  /**
   * The finding the live transcript still showed after the registry landed: an
   * MP3 sent from the device's document picker arrives as `type: document` with
   * `mime_type: audio/mpeg`, and a renderer keyed on the stored type gives a
   * customer who plainly sent audio a download link with a file icon.
   */
  it('renders media by what it is, not by the type Meta labelled it', () => {
    const mp3 = {
      ...EMPTY_MEDIA,
      kind: 'DOCUMENT',
      mimeType: 'audio/mpeg',
      fileName: 'untitled.mp3',
    };

    expect(
      projectContent(source({ type: 'DOCUMENT', body: 'untitled.mp3', media: mp3 })),
    ).toEqual({ kind: 'audio', media: mp3, isVoice: false });

    const photo = { ...EMPTY_MEDIA, kind: 'DOCUMENT', mimeType: 'image/png' };

    expect(projectContent(source({ type: 'DOCUMENT', media: photo }))).toMatchObject({
      kind: 'image',
    });
  });

  /** A real document is still a document; the override only reroutes media. */
  it('leaves an ordinary document alone', () => {
    const pdf = { ...EMPTY_MEDIA, kind: 'DOCUMENT', mimeType: 'application/pdf' };

    expect(projectContent(source({ type: 'DOCUMENT', media: pdf }))).toMatchObject({
      kind: 'document',
    });
  });

  it('keeps an unknown type readable rather than dropping it (FR-IN-1)', () => {
    expect(
      projectContent(source({ type: 'ORDER', body: '3 artigos' })),
    ).toEqual({ kind: 'unsupported', sourceType: 'ORDER', body: '3 artigos' });
  });
});

describe('projectInteractive', () => {
  it('reads a list message with its sections and rows', () => {
    expect(
      projectInteractive({
        type: 'list',
        body: { text: 'Escolha um plano' },
        action: {
          button: 'Ver opções',
          sections: [
            {
              title: 'Planos',
              rows: [
                { id: 'row_1', title: 'Starter', description: 'Até 100 contactos' },
                { id: 'row_2', title: 'Pro' },
              ],
            },
          ],
        },
      }),
    ).toEqual({
      kind: 'list',
      header: null,
      body: 'Escolha um plano',
      footer: null,
      buttonText: 'Ver opções',
      sections: [
        {
          title: 'Planos',
          rows: [
            { id: 'row_1', title: 'Starter', description: 'Até 100 contactos' },
            { id: 'row_2', title: 'Pro', description: null },
          ],
        },
      ],
    });
  });

  it('keeps a subtype this app cannot compose readable instead of empty', () => {
    expect(projectInteractive({ type: 'cta_url', body: { text: 'Abrir' } })).toEqual({
      kind: 'other',
      interactiveType: 'cta_url',
      body: 'Abrir',
    });
  });
});

describe('effectiveKind', () => {
  /**
   * An audio file sent from the device's document picker arrives as
   * `type: document` with an audio MIME type. Keying on the stored type alone
   * gives a customer who plainly sent audio a bare download link.
   */
  it('trusts the MIME type over the label Meta put on the message', () => {
    expect(
      effectiveKind({ ...EMPTY_MEDIA, kind: 'DOCUMENT', mimeType: 'audio/mpeg' }),
    ).toBe('audio');
  });

  it('falls back to the message type when there is no MIME type', () => {
    expect(effectiveKind({ ...EMPTY_MEDIA, kind: 'VIDEO' })).toBe('video');
    expect(effectiveKind({ ...EMPTY_MEDIA, kind: 'DOCUMENT' })).toBe('file');
    expect(effectiveKind(null)).toBeNull();
  });

  it('never demotes a sticker, whatever it is encoded as', () => {
    expect(
      effectiveKind({ ...EMPTY_MEDIA, kind: 'STICKER', mimeType: 'image/webp' }),
    ).toBe('sticker');
  });
});

describe('documentFamily', () => {
  it('names the icon family from the MIME type, then from the extension', () => {
    expect(documentFamily({ ...EMPTY_MEDIA, mimeType: 'application/pdf' })).toBe('pdf');
    expect(documentFamily({ ...EMPTY_MEDIA, fileName: 'Vendas.XLSX' })).toBe('sheet');
    expect(documentFamily({ ...EMPTY_MEDIA, fileName: 'notas.txt' })).toBe('doc');
    expect(documentFamily({ ...EMPTY_MEDIA, fileName: 'entrega.zip' })).toBe('archive');
    expect(documentFamily({ ...EMPTY_MEDIA, fileName: 'sem-extensao' })).toBe('file');
    expect(documentFamily(null)).toBe('file');
  });
});
