import { describe, expect, it } from 'vitest';

import {
  bodyVariableHints,
  buttonLabels,
  buttonVariableHints,
  contextFor,
  headerVariableHints,
  mediaHeaderOf,
} from './template-hints';
import {
  emptyParameters,
  validateParameters,
  type ResolvedParameters,
} from './template-render';
import type { VariableSpec } from './template-spec';

/**
 * The information was always there. These tests are about reading it — the
 * picker labelled six inputs `{{1}}` … `{{6}}` while the body text next to
 * every one of them said what it was for.
 */

const BODY = [
  'Olá, {{1}}! 🎉',
  '',
  'É com muita alegria que lhe enviamos o seu convite para {{2}}.',
  '',
  '📅 Data: {{4}} (hora de Luanda)',
  '📍 Local: {{5}}',
].join('\n');

const spec = (overrides: Partial<VariableSpec['body']> = {}): VariableSpec => ({
  namedParameters: false,
  header: null,
  body: {
    variableCount: 4,
    indices: [1, 2, 4, 5],
    names: [],
    text: BODY,
    example: ['Marcos', 'a Gala Anual', '12 de Setembro', 'Talatona Convention Centre'],
    ...overrides,
  },
  footer: null,
  buttons: [],
  totalVariableCount: 4,
});

describe('contextFor', () => {
  it('returns the line the placeholder sits in', () => {
    expect(contextFor(BODY, '{{4}}')).toBe('📅 Data: {{4}} (hora de Luanda)');
    expect(contextFor(BODY, '{{1}}')).toBe('Olá, {{1}}! 🎉');
  });

  it('answers nothing when the template stored no body text', () => {
    expect(contextFor(null, '{{1}}')).toBeNull();
    expect(contextFor('', '{{1}}')).toBeNull();
  });

  it('answers nothing for a placeholder the body does not contain', () => {
    expect(contextFor(BODY, '{{9}}')).toBeNull();
  });

  /**
   * A label is a label. A 400-character paragraph above an input is not more
   * informative than a short one — it is a paragraph you have to read to find
   * the input.
   */
  it('windows a long line around the placeholder, on word boundaries', () => {
    const long = `${'palavra '.repeat(20)}{{1}} ${'outra '.repeat(20)}`;
    const context = contextFor(long, '{{1}}');

    expect(context).not.toBeNull();
    expect(context!.length).toBeLessThan(100);
    expect(context).toContain('{{1}}');
    expect(context!.startsWith('… ')).toBe(true);
    expect(context!.endsWith(' …')).toBe(true);
  });

  it('collapses the whitespace a template body is full of', () => {
    expect(contextFor('Data:   {{1}}\t(Luanda)', '{{1}}')).toBe('Data: {{1}} (Luanda)');
  });
});

describe('bodyVariableHints', () => {
  it('pairs each variable with its surrounding words and Meta’s own example', () => {
    expect(bodyVariableHints(spec())).toEqual([
      { token: '{{1}}', context: 'Olá, {{1}}! 🎉', example: 'Marcos' },
      {
        token: '{{2}}',
        context: 'É com muita alegria que lhe enviamos o seu convite para {{2}}.',
        example: 'a Gala Anual',
      },
      {
        token: '{{4}}',
        context: '📅 Data: {{4}} (hora de Luanda)',
        example: '12 de Setembro',
      },
      {
        token: '{{5}}',
        context: '📍 Local: {{5}}',
        example: 'Talatona Convention Centre',
      },
    ]);
  });

  /**
   * The order is `indices`, not the order of appearance in the text — that is
   * the contract `ResolvedParameters.body` was built against, and reordering
   * would fill `{{2}}` with something meant for `{{1}}`.
   */
  it('keeps the parameter order the send path expects', () => {
    const reversed = spec({ indices: [5, 4, 2, 1] });

    expect(bodyVariableHints(reversed).map((hint) => hint.token)).toEqual([
      '{{5}}',
      '{{4}}',
      '{{2}}',
      '{{1}}',
    ]);
  });

  it('reads named parameters through the same path', () => {
    const named: VariableSpec = {
      ...spec(),
      namedParameters: true,
      body: {
        variableCount: 1,
        indices: [],
        names: ['nome'],
        text: 'Olá, {{nome}}!',
        example: ['Marcos'],
      },
    };

    expect(bodyVariableHints(named)).toEqual([
      { token: '{{nome}}', context: 'Olá, {{nome}}!', example: 'Marcos' },
    ]);
  });

  it('survives a template that synced without examples or body text', () => {
    const bare = spec({ text: null, example: [] });

    expect(bodyVariableHints(bare)[0]).toEqual({
      token: '{{1}}',
      context: null,
      example: null,
    });
  });

  it('has nothing to say about a template that was never selected', () => {
    expect(bodyVariableHints(null)).toEqual([]);
  });
});

/**
 * The deeper half of the same bug: `validateParameters` counts header and
 * button variables, the form only ever offered body ones, and a template with
 * either could therefore never satisfy its own validator. Filling every visible
 * box left Send disabled and a counter reading "Missing: 8".
 */
describe('headerVariableHints', () => {
  const withHeader = (
    header: Partial<NonNullable<VariableSpec['header']>>,
  ): VariableSpec => ({
    ...spec(),
    header: {
      format: 'TEXT',
      variableCount: 1,
      indices: [1],
      names: [],
      text: 'Convite para {{1}}',
      example: ['a Gala Anual'],
      ...header,
    },
  });

  it('collects a text header’s variables the same way as the body’s', () => {
    expect(headerVariableHints(withHeader({}))).toEqual([
      { token: '{{1}}', context: 'Convite para {{1}}', example: 'a Gala Anual' },
    ]);
  });

  /** A media header needs a file, not a word; `mediaHeaderOf` covers it. */
  it('offers nothing for a media header', () => {
    expect(headerVariableHints(withHeader({ format: 'IMAGE' }))).toEqual([]);
  });

  it('offers nothing for a header with no variables, or no header at all', () => {
    expect(headerVariableHints(withHeader({ variableCount: 0, indices: [] }))).toEqual([]);
    expect(headerVariableHints(spec())).toEqual([]);
    expect(headerVariableHints(null)).toEqual([]);
  });
});

/**
 * D-59. `assessSupport` refuses only a *location* header, so a template with an
 * image header syncs as usable and is offered in both the picker and the
 * campaign builder — while `validateParameters` counts its file as a required
 * parameter and neither form collected one. Send was permanently disabled, and
 * a campaign built on such a template excluded every recipient for "missing
 * variables". The comment beside `headerVariableHints` asserted these templates
 * "never reach the picker", which was never true.
 */
describe('mediaHeaderOf', () => {
  const withHeader = (
    header: Partial<NonNullable<VariableSpec['header']>>,
  ): VariableSpec => ({
    ...spec(),
    header: {
      format: 'IMAGE',
      variableCount: 0,
      indices: [],
      names: [],
      text: null,
      example: ['4::aW1hZ2UvcG5n:ARZ…'],
      ...header,
    },
  });

  it.each(['IMAGE', 'VIDEO', 'DOCUMENT'] as const)('asks for a file for a %s header', (format) => {
    expect(mediaHeaderOf(withHeader({ format }))).toEqual({ format });
  });

  it('asks for nothing where there is no file to collect', () => {
    expect(mediaHeaderOf(withHeader({ format: 'TEXT' }))).toBeNull();
    expect(mediaHeaderOf(withHeader({ format: 'LOCATION' }))).toBeNull();
    expect(mediaHeaderOf(spec())).toBeNull();
    expect(mediaHeaderOf(null)).toBeNull();
  });
});

describe('buttonVariableHints', () => {
  const withButtons = (buttons: VariableSpec['buttons']): VariableSpec => ({
    ...spec(),
    buttons,
  });

  it('asks only for the buttons that carry a variable', () => {
    expect(
      buttonVariableHints(
        withButtons([
          { index: 0, type: 'QUICK_REPLY', hasVariable: false, text: 'Sim', url: null },
          {
            index: 1,
            type: 'URL',
            hasVariable: true,
            text: 'Responder',
            url: 'https://pixel.ao/r/{{1}}',
          },
        ]),
      ),
    ).toEqual([
      {
        index: 1,
        subType: 'url',
        label: 'Responder',
        url: 'https://pixel.ao/r/{{1}}',
      },
    ]);
  });

  it('names a copy-code button by the sub_type Meta expects', () => {
    expect(
      buttonVariableHints(
        withButtons([
          { index: 0, type: 'COPY_CODE', hasVariable: true, text: 'Copiar', url: null },
        ]),
      )[0],
    ).toMatchObject({ subType: 'copy_code' });
  });

  it('asks for nothing when no button carries one', () => {
    expect(buttonVariableHints(spec())).toEqual([]);
    expect(buttonVariableHints(null)).toEqual([]);
  });
});

/**
 * The invariant the picker exists to satisfy, and the one it silently broke:
 * **every variable the validator counts must have a field to fill it in.**
 *
 * The form offered body variables only, `validateParameters` also counted the
 * header and the buttons, and a template with either could therefore never
 * reach `ok: true` — Send stayed disabled for ever under a counter that read
 * "Missing: 8" with six boxes on screen. Asserting the two sets agree is what
 * stops that returning the next time either side grows a component.
 */
describe('the fields the picker renders cover everything the validator wants', () => {
  const fill = (spec: VariableSpec): ResolvedParameters => {
    const header = headerVariableHints(spec);
    const media = mediaHeaderOf(spec);
    const buttons = buttonVariableHints(spec);

    return {
      body: bodyVariableHints(spec).map((_, index) => `body ${index}`),
      ...(media !== null
        ? {
            header: {
              kind: 'media' as const,
              mediaId: null,
              fileId: null,
              fileUrl: 'https://crm.test/files/attachment/header.png',
            },
          }
        : header.length === 0
          ? {}
          : {
              header: {
                kind: 'text' as const,
                values: header.map((_, index) => `header ${index}`),
              },
            }),
      buttons: buttons.map((button) => ({
        index: button.index,
        subType: button.subType,
        value: `button ${button.index}`,
      })),
    };
  };

  it('satisfies a body-only template', () => {
    expect(validateParameters(spec(), fill(spec()))).toMatchObject({ ok: true });
  });

  it('satisfies a template with a text header and a dynamic button', () => {
    const full: VariableSpec = {
      ...spec(),
      header: {
        format: 'TEXT',
        variableCount: 1,
        indices: [1],
        names: [],
        text: 'Convite para {{1}}',
        example: ['a Gala Anual'],
      },
      buttons: [
        { index: 0, type: 'QUICK_REPLY', hasVariable: false, text: 'Sim', url: null },
        {
          index: 1,
          type: 'URL',
          hasVariable: true,
          text: 'Responder',
          url: 'https://pixel.ao/r/{{1}}',
        },
      ],
    };

    const result = validateParameters(full, fill(full));

    expect(result.missingKeys).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /**
   * The template QA got stuck on: six body variables, an image header and a
   * dynamic button. Every visible box filled, and Send still disabled, because
   * the header had no box at all (D-59).
   */
  it('satisfies a template with a media header, body variables and a dynamic button', () => {
    const full: VariableSpec = {
      ...spec(),
      header: {
        format: 'IMAGE',
        variableCount: 0,
        indices: [],
        names: [],
        text: null,
        example: ['4::aW1hZ2UvcG5n:ARZ…'],
      },
      buttons: [
        { index: 0, type: 'URL', hasVariable: true, text: 'Confirmar', url: 'https://x/{{1}}' },
      ],
    };

    const result = validateParameters(full, fill(full));

    expect(result.missingKeys).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /** And an empty form still reports every one of them, so nothing is hidden. */
  it('reports one missing key per field the picker renders', () => {
    const full: VariableSpec = {
      ...spec(),
      header: {
        format: 'TEXT',
        variableCount: 1,
        indices: [1],
        names: [],
        text: 'Convite para {{1}}',
        example: [],
      },
      buttons: [
        { index: 0, type: 'URL', hasVariable: true, text: 'Abrir', url: 'https://x/{{1}}' },
      ],
    };

    const fieldCount =
      bodyVariableHints(full).length +
      headerVariableHints(full).length +
      buttonVariableHints(full).length;

    expect(validateParameters(full, emptyParameters()).missingKeys).toHaveLength(fieldCount);
  });
});

describe('buttonLabels', () => {
  /**
   * A body ending "responda através do botão abaixo" describes a button the
   * preview did not draw, so a rep could not tell whether the template they
   * were about to send actually had one.
   */
  it('lists the buttons the customer will see', () => {
    const withButtons: VariableSpec = {
      ...spec(),
      buttons: [
        { index: 0, type: 'QUICK_REPLY', hasVariable: false, text: 'Confirmo', url: null },
        { index: 1, type: 'QUICK_REPLY', hasVariable: false, text: 'Não posso', url: null },
      ],
    };

    expect(buttonLabels(withButtons)).toEqual(['Confirmo', 'Não posso']);
  });

  it('drops a button with no label rather than drawing an empty one', () => {
    const unlabelled: VariableSpec = {
      ...spec(),
      buttons: [{ index: 0, type: 'URL', hasVariable: true, text: null, url: 'https://x' }],
    };

    expect(buttonLabels(unlabelled)).toEqual([]);
    expect(buttonLabels(null)).toEqual([]);
  });
});
