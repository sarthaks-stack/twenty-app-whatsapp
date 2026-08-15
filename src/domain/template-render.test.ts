import { describe, expect, it } from 'vitest';

import {
  PARAMETER_LIMITS,
  bindPlaceholders,
  renderTemplate,
  renderTemplateBody,
  sanitiseParameter,
  sanitiseResolvedParameters,
  validateParameters,
  type ResolvedParameters,
} from './template-render';
import { deriveVariableSpec, type MetaTemplateComponent } from './template-spec';

const spec = (components: MetaTemplateComponent[]) => deriveVariableSpec(components);

const params = (overrides: Partial<ResolvedParameters> = {}): ResolvedParameters => ({
  body: [],
  buttons: [],
  ...overrides,
});

describe('sanitiseParameter', () => {
  /** WhatsApp rejects these outright — the 132000 family. */
  it('flattens newlines and tabs to single spaces', () => {
    expect(sanitiseParameter('linha 1\nlinha 2\tfim')).toBe('linha 1 linha 2 fim');
    expect(sanitiseParameter('a\r\n\r\nb')).toBe('a b');
  });

  it('clips a run of five or more spaces to four, keeping deliberate spacing', () => {
    expect(sanitiseParameter('a          b')).toBe('a    b');
    expect(sanitiseParameter('a   b')).toBe('a   b');
  });

  it('trims and handles absent values', () => {
    expect(sanitiseParameter('  Marcos  ')).toBe('Marcos');
    expect(sanitiseParameter(null)).toBe('');
    expect(sanitiseParameter(undefined)).toBe('');
  });

  it('truncates to the limit with an ellipsis', () => {
    const result = sanitiseParameter('x'.repeat(80), { maxLength: PARAMETER_LIMITS.HEADER });

    expect(result).toHaveLength(PARAMETER_LIMITS.HEADER);
    expect(result.endsWith('…')).toBe(true);
  });

  /** An ellipsis inside a URL suffix breaks the link it is meant to build. */
  it('truncates without an ellipsis when asked', () => {
    const result = sanitiseParameter('x'.repeat(20), { maxLength: 10, ellipsis: false });

    expect(result).toBe('x'.repeat(10));
  });

  it('leaves a value at exactly the limit alone', () => {
    expect(sanitiseParameter('x'.repeat(60), { maxLength: 60 })).toBe('x'.repeat(60));
  });
});

describe('bindPlaceholders', () => {
  it('substitutes resolved values', () => {
    expect(bindPlaceholders('Olá {{1}}, da {{2}}', (t) => ({ '1': 'Marcos', '2': 'Pixel' })[t] ?? null)).toBe(
      'Olá Marcos, da Pixel',
    );
  });

  /**
   * An unresolved variable stays visible on purpose: a blank gap reads as
   * finished copy in the preview, `{{2}}` reads as work remaining.
   */
  it('leaves an unresolved placeholder in place rather than blanking it', () => {
    expect(bindPlaceholders('Olá {{1}}, ref {{2}}', (t) => (t === '1' ? 'Marcos' : null))).toBe(
      'Olá Marcos, ref {{2}}',
    );
  });

  it('substitutes every occurrence of a repeated placeholder', () => {
    expect(bindPlaceholders('{{1}} e {{1}}', () => 'X')).toBe('X e X');
  });

  it('handles absent text', () => {
    expect(bindPlaceholders(undefined, () => 'X')).toBe('');
  });
});

describe('renderTemplateBody', () => {
  const positional = spec([{ type: 'BODY', text: 'Olá {{1}}, a {{2}} agradece.' }]);

  it('fills positional variables in array order', () => {
    expect(renderTemplateBody(positional, params({ body: ['Marcos', 'Pixel'] }))).toBe(
      'Olá Marcos, a Pixel agradece.',
    );
  });

  it('fills named variables by name', () => {
    const named = spec([{ type: 'BODY', text: 'Olá {{nome}}, a {{empresa}} agradece.' }]);

    expect(renderTemplateBody(named, params({ body: ['Marcos', 'Pixel'] }))).toBe(
      'Olá Marcos, a Pixel agradece.',
    );
  });

  /**
   * `body[i]` maps to `spec.body.indices[i]`, not to `{{i+1}}`. With a gap the
   * two differ, and getting it wrong swaps the customer's name for their
   * company's.
   */
  it('maps by position in the index list, not by literal placeholder number', () => {
    const gapped = spec([{ type: 'BODY', text: 'Ref {{2}} para {{5}}' }]);

    expect(renderTemplateBody(gapped, params({ body: ['A', 'B'] }))).toBe('Ref A para B');
  });
});

describe('renderTemplate', () => {
  const components: MetaTemplateComponent[] = [
    { type: 'HEADER', format: 'TEXT', text: 'Proposta {{1}}' },
    { type: 'BODY', text: 'Olá {{1}}' },
    { type: 'FOOTER', text: 'Responda SAIR para deixar de receber' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://x.ao/{{1}}' }] },
  ];

  it('renders every part', () => {
    expect(
      renderTemplate(
        spec(components),
        params({ header: { kind: 'text', values: ['Setembro'] }, body: ['Marcos'] }),
      ),
    ).toEqual({
      header: 'Proposta Setembro',
      body: 'Olá Marcos',
      footer: 'Responda SAIR para deixar de receber',
      buttons: [{ index: 0, type: 'URL', text: 'Ver' }],
    });
  });

  it('renders no header text for a media header', () => {
    const rendered = renderTemplate(
      spec([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Olá' }]),
      params({ header: { kind: 'media', mediaId: '123', fileId: null } }),
    );

    expect(rendered.header).toBeNull();
  });
});

describe('validateParameters', () => {
  const twoVars = spec([{ type: 'BODY', text: 'Olá {{1}}, a {{2}} agradece.' }]);

  it('accepts a fully resolved set', () => {
    expect(validateParameters(twoVars, params({ body: ['Marcos', 'Pixel'] }))).toEqual({
      ok: true,
      missing: [],
      missingKeys: [],
    });
  });

  /** Meta rejects an empty parameter, so this is a send that cannot succeed. */
  it.each([[''], ['   '], [undefined]])('rejects a blank value (%p)', (value) => {
    const result = validateParameters(twoVars, params({ body: ['Marcos', value as string] }));

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([2]);
    expect(result.missingKeys).toEqual(['{{2}}']);
  });

  it('reports every gap, not just the first', () => {
    expect(validateParameters(twoVars, params()).missing).toEqual([1, 2]);
  });

  it('requires a media header to carry an id or a reachable file', () => {
    const mediaHeader = spec([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Olá' }]);

    expect(validateParameters(mediaHeader, params()).missingKeys).toEqual(['header image']);

    // Meta's own id: already uploaded, nothing to fetch.
    expect(
      validateParameters(mediaHeader, params({ header: { kind: 'media', mediaId: '1', fileId: null } })).ok,
    ).toBe(true);

    // A storage handle: the sender can fetch these bytes and upload them.
    for (const handle of [{ filePath: 'files/header.png' }, { fileUrl: '/files/header.png' }]) {
      expect(
        validateParameters(
          mediaHeader,
          params({ header: { kind: 'media', mediaId: null, fileId: null, ...handle } }),
        ).ok,
        JSON.stringify(handle),
      ).toBe(true);
    }
  });

  /**
   * A record id names the file without naming its content, so it is not enough
   * to send with — the sender has nothing to fetch. Accepting it here would
   * turn a pre-flight exclusion with a clear reason into a Meta rejection for
   * every recipient of a campaign.
   */
  it('does not accept a bare fileId as a resolved media header', () => {
    const mediaHeader = spec([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Olá' }]);

    expect(
      validateParameters(mediaHeader, params({ header: { kind: 'media', mediaId: null, fileId: 'f' } }))
        .missingKeys,
    ).toEqual(['header image']);
  });

  it('requires a text header variable', () => {
    const textHeader = spec([
      { type: 'HEADER', format: 'TEXT', text: 'Proposta {{1}}' },
      { type: 'BODY', text: 'Olá' },
    ]);

    expect(validateParameters(textHeader, params()).missingKeys).toEqual(['header {{1}}']);
  });

  it('requires a value for a button that has one and ignores buttons that do not', () => {
    const buttons = spec([
      { type: 'BODY', text: 'Olá' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Ver', url: 'https://x.ao/{{1}}' },
          { type: 'QUICK_REPLY', text: 'Parar' },
        ],
      },
    ]);

    expect(validateParameters(buttons, params()).missingKeys).toEqual(['button 0']);
    expect(
      validateParameters(
        buttons,
        params({ buttons: [{ index: 0, subType: 'url', value: 'abc123' }] }),
      ).ok,
    ).toBe(true);
  });

  it('accepts a template with no variables at all', () => {
    expect(validateParameters(spec([{ type: 'BODY', text: 'Obrigado!' }]), params()).ok).toBe(true);
  });
});

describe('sanitiseResolvedParameters', () => {
  it('applies each component limit and leaves media headers untouched', () => {
    const result = sanitiseResolvedParameters({
      header: { kind: 'text', values: ['x'.repeat(100)] },
      body: ['linha\nquebrada'],
      buttons: [{ index: 0, subType: 'url', value: 'y'.repeat(2500) }],
    });

    expect(result.header).toEqual({
      kind: 'text',
      values: [`${'x'.repeat(PARAMETER_LIMITS.HEADER - 1)}…`],
    });
    expect(result.body).toEqual(['linha quebrada']);
    expect(result.buttons[0]!.value).toHaveLength(PARAMETER_LIMITS.BUTTON_URL);
    expect(result.buttons[0]!.value.endsWith('…')).toBe(false);
  });

  it('passes a media header through unchanged', () => {
    const header = { kind: 'media', mediaId: '123', fileId: null } as const;

    expect(sanitiseResolvedParameters({ header, body: [], buttons: [] }).header).toBe(header);
  });
});
