import { describe, expect, it } from 'vitest';

import { emptyParameters } from '../../domain/template-render';
import { deriveVariableSpec, type MetaTemplateComponent } from '../../domain/template-spec';
import {
  buildContactsPayload,
  buildInteractiveButtonsPayload,
  buildInteractiveListPayload,
  buildLocationPayload,
  buildMediaPayload,
  buildReactionPayload,
  buildTemplateComponents,
  buildTemplatePayload,
  buildTextPayload,
} from './payload';

/**
 * Contract tests for the wire format (specs/12 §3). Whole-payload equality, not
 * spot checks: an extra field Meta does not expect is as much a defect as a
 * missing one, and only a full comparison catches it.
 */

const TO = '244917164819';

describe('text', () => {
  it('builds the documented envelope', () => {
    expect(buildTextPayload({ to: TO, body: 'Olá!' })).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'text',
      text: { body: 'Olá!', preview_url: true },
    });
  });

  it('attaches a quoted-reply context', () => {
    expect(buildTextPayload({ to: TO, body: 'sim', contextWamid: 'wamid.PARENT' })).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'text',
      context: { message_id: 'wamid.PARENT' },
      text: { body: 'sim', preview_url: true },
    });
  });

  it('omits context entirely when there is none', () => {
    expect(buildTextPayload({ to: TO, body: 'x', contextWamid: null })).not.toHaveProperty(
      'context',
    );
  });
});

describe('media', () => {
  /** AR-14: `id`, never `link`. A link send needs a publicly reachable URL. */
  it('sends by media id and never by link', () => {
    const payload = buildMediaPayload({ to: TO, kind: 'image', mediaId: '123', caption: 'Proposta' });

    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'image',
      image: { id: '123', caption: 'Proposta' },
    });
    expect(JSON.stringify(payload)).not.toContain('link');
  });

  it('adds a filename for documents', () => {
    expect(
      buildMediaPayload({
        to: TO,
        kind: 'document',
        mediaId: '123',
        filename: 'contrato.pdf',
      }).document,
    ).toEqual({ id: '123', filename: 'contrato.pdf' });
  });

  /** Meta rejects a caption on audio and stickers outright. */
  it.each(['audio', 'sticker'] as const)('omits the caption for %s', (kind) => {
    expect(buildMediaPayload({ to: TO, kind, mediaId: '1', caption: 'nope' })[kind]).toEqual({
      id: '1',
    });
  });

  it('omits an empty caption rather than sending an empty string', () => {
    expect(buildMediaPayload({ to: TO, kind: 'image', mediaId: '1', caption: '' }).image).toEqual({
      id: '1',
    });
  });
});

describe('location and contacts', () => {
  it('builds a location', () => {
    expect(
      buildLocationPayload({ to: TO, latitude: -8.83, longitude: 13.23, name: 'Escritório' }),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'location',
      location: { latitude: -8.83, longitude: 13.23, name: 'Escritório' },
    });
  });

  it('passes contact cards through verbatim', () => {
    const contacts = [{ name: { formatted_name: 'Ana Silva' } }];

    expect(buildContactsPayload({ to: TO, contacts }).contacts).toBe(contacts);
  });
});

describe('reactions', () => {
  it('builds an add', () => {
    expect(buildReactionPayload({ to: TO, targetWamid: 'wamid.T', emoji: '👍' })).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'reaction',
      reaction: { message_id: 'wamid.T', emoji: '👍' },
    });
  });

  it('removes with an empty emoji rather than a delete call', () => {
    expect(
      buildReactionPayload({ to: TO, targetWamid: 'wamid.T', emoji: '' }).reaction,
    ).toEqual({ message_id: 'wamid.T', emoji: '' });
  });

  /** A reaction names its target already; adding a context makes Meta reject it. */
  it('never carries a context', () => {
    expect(buildReactionPayload({ to: TO, targetWamid: 'wamid.T', emoji: '👍' })).not.toHaveProperty(
      'context',
    );
  });
});

describe('interactive', () => {
  it('builds reply buttons', () => {
    expect(
      buildInteractiveButtonsPayload({
        to: TO,
        body: 'Confirma?',
        footer: 'Equipa Pixel',
        buttons: [
          { id: 'sim', title: 'Sim' },
          { id: 'nao', title: 'Não' },
        ],
      }).interactive,
    ).toEqual({
      type: 'button',
      body: { text: 'Confirma?' },
      footer: { text: 'Equipa Pixel' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'sim', title: 'Sim' } },
          { type: 'reply', reply: { id: 'nao', title: 'Não' } },
        ],
      },
    });
  });

  it('refuses more than three buttons before Meta does', () => {
    expect(() =>
      buildInteractiveButtonsPayload({
        to: TO,
        body: 'x',
        buttons: Array.from({ length: 4 }, (_u, i) => ({ id: `${i}`, title: `${i}` })),
      }),
    ).toThrow(RangeError);
  });

  it('refuses zero buttons', () => {
    expect(() => buildInteractiveButtonsPayload({ to: TO, body: 'x', buttons: [] })).toThrow(
      RangeError,
    );
  });

  it('builds a list', () => {
    expect(
      buildInteractiveListPayload({
        to: TO,
        body: 'Escolha um plano',
        buttonText: 'Ver planos',
        sections: [{ title: 'Planos', rows: [{ id: 'pro', title: 'Pro' }] }],
      }).interactive,
    ).toEqual({
      type: 'list',
      body: { text: 'Escolha um plano' },
      action: {
        button: 'Ver planos',
        sections: [{ title: 'Planos', rows: [{ id: 'pro', title: 'Pro' }] }],
      },
    });
  });
});

describe('templates', () => {
  const components: MetaTemplateComponent[] = [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Olá {{1}}, a {{2}} agradece.' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://x.ao/{{1}}' }] },
  ];

  it('builds the appendix A shape end to end', () => {
    expect(
      buildTemplatePayload({
        to: TO,
        name: 'proposta_setembro',
        languageCode: 'pt_PT',
        spec: deriveVariableSpec(components),
        parameters: {
          header: { kind: 'media', mediaId: '999', fileId: null },
          body: ['Marcos', 'Pixel'],
          buttons: [{ index: 0, subType: 'url', value: 'abc123' }],
        },
      }),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'template',
      template: {
        name: 'proposta_setembro',
        language: { code: 'pt_PT' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { id: '999' } }] },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Marcos' },
              { type: 'text', text: 'Pixel' },
            ],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: 'abc123' }],
          },
        ],
      },
    });
  });

  /** Meta rejects a numeric button index; it must be a string. */
  it('sends the button index as a string', () => {
    const built = buildTemplateComponents(deriveVariableSpec(components), {
      body: [],
      buttons: [{ index: 2, subType: 'url', value: 'x' }],
    });

    expect(built[0]!.index).toBe('2');
  });

  it('emits no components block for a template with no variables', () => {
    expect(
      buildTemplatePayload({
        to: TO,
        name: 'obrigado',
        languageCode: 'pt_PT',
        spec: deriveVariableSpec([{ type: 'BODY', text: 'Obrigado!' }]),
        parameters: emptyParameters(),
      }).template,
    ).toEqual({ name: 'obrigado', language: { code: 'pt_PT' } });
  });

  it('adds parameter_name only for a genuinely named template', () => {
    const named = deriveVariableSpec([{ type: 'BODY', text: 'Olá {{nome}}' }]);

    expect(buildTemplateComponents(named, { body: ['Marcos'], buttons: [] })).toEqual([
      { type: 'body', parameters: [{ type: 'text', parameter_name: 'nome', text: 'Marcos' }] },
    ]);

    const positional = deriveVariableSpec([{ type: 'BODY', text: 'Olá {{1}}' }]);

    expect(
      buildTemplateComponents(positional, { body: ['Marcos'], buttons: [] })[0]!.parameters[0],
    ).not.toHaveProperty('parameter_name');
  });

  it('builds a text header parameter block', () => {
    const spec = deriveVariableSpec([
      { type: 'HEADER', format: 'TEXT', text: 'Proposta {{1}}' },
      { type: 'BODY', text: 'Olá' },
    ]);

    expect(
      buildTemplateComponents(spec, {
        header: { kind: 'text', values: ['Setembro'] },
        body: [],
        buttons: [],
      }),
    ).toEqual([{ type: 'header', parameters: [{ type: 'text', text: 'Setembro' }] }]);
  });

  it('maps each media header format to its own parameter type', () => {
    for (const [format, key] of [
      ['IMAGE', 'image'],
      ['VIDEO', 'video'],
      ['DOCUMENT', 'document'],
    ] as const) {
      const spec = deriveVariableSpec([{ type: 'HEADER', format }, { type: 'BODY', text: 'x' }]);
      const built = buildTemplateComponents(spec, {
        header: { kind: 'media', mediaId: '7', fileId: null },
        body: [],
        buttons: [],
      });

      expect(built[0]!.parameters[0]).toEqual({ type: key, [key]: { id: '7' } });
    }
  });

  /** Sanitisation runs again here, so no route to the wire can bypass it. */
  it('sanitises parameters at the wire boundary', () => {
    const spec = deriveVariableSpec([{ type: 'BODY', text: 'Olá {{1}}' }]);

    expect(
      buildTemplateComponents(spec, { body: ['Marcos\nLisboa'], buttons: [] })[0]!.parameters[0],
    ).toEqual({ type: 'text', text: 'Marcos Lisboa' });
  });
});
