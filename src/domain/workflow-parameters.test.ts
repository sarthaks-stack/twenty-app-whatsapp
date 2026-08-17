import { describe, expect, it } from 'vitest';

import type { VariableSpec } from './template-spec';
import {
  BODY_VARIABLE_SLOTS,
  bindWorkflowParameters,
  combineVariableInputs,
} from './workflow-parameters';

/**
 * The one place in the app where variables are supplied by a caller who never
 * saw the template (FR-WF-1).
 *
 * A rep filling the picker sees each `{{2}}` beside the sentence it belongs to.
 * A workflow author fills an untyped `Variables` object from memory, so every
 * plausible spelling of the same intent has to land on the same position — and
 * anything that does not resolve has to come back *empty*, because empty is
 * what `validateParameters` reports as a named missing variable and a stringified
 * `null` is what a customer would otherwise read.
 */

const positional = (overrides: Partial<VariableSpec> = {}): VariableSpec => ({
  namedParameters: false,
  header: null,
  body: {
    variableCount: 2,
    indices: [1, 2],
    names: [],
    text: 'Olá {{1}}, a sua encomenda {{2}} está pronta.',
    example: [],
  },
  footer: null,
  buttons: [],
  totalVariableCount: 2,
  ...overrides,
});

const named = (): VariableSpec => ({
  ...positional(),
  namedParameters: true,
  body: {
    variableCount: 2,
    indices: [],
    names: ['nome', 'referencia'],
    text: 'Olá {{nome}}, a sua encomenda {{referencia}} está pronta.',
    example: [],
  },
});

describe('binding a body', () => {
  it('reads Meta’s own 1-based keys', () => {
    expect(bindWorkflowParameters(positional(), { 1: 'Ana', 2: 'AO-4471' }).body).toEqual([
      'Ana',
      'AO-4471',
    ]);
  });

  it('reads the same keys nested under body', () => {
    expect(
      bindWorkflowParameters(positional(), { body: { 1: 'Ana', 2: 'AO-4471' } }).body,
    ).toEqual(['Ana', 'AO-4471']);
  });

  it('reads named placeholders, with or without braces', () => {
    expect(
      bindWorkflowParameters(named(), { nome: 'Ana', '{{referencia}}': 'AO-4471' }).body,
    ).toEqual(['Ana', 'AO-4471']);
  });

  /**
   * A number binds a named template too, by position. The step's numbered fields
   * can only send positions — the builder has no way to know the names — so
   * without this they bound nothing at all on every named template.
   */
  it('reads a number as a position on a named template', () => {
    expect(bindWorkflowParameters(named(), { 1: 'Ana', 2: 'AO-4471' }).body).toEqual([
      'Ana',
      'AO-4471',
    ]);
  });

  /** The name still wins where both are given. */
  it('prefers the name over the position', () => {
    expect(
      bindWorkflowParameters(named(), { nome: 'Ana', 1: 'Marcos' }).body,
    ).toEqual(['Ana', '']);
  });

  /**
   * Order comes from the spec, never from the object. `Object.keys` on
   * `{ 2: …, 1: … }` happens to sort numeric keys, but on `{ referencia, nome }`
   * it does not — and a body bound in insertion order would put the reference
   * number where the name goes for every recipient.
   */
  it('orders by the spec rather than by the object', () => {
    expect(
      bindWorkflowParameters(named(), { referencia: 'AO-4471', nome: 'Ana' }).body,
    ).toEqual(['Ana', 'AO-4471']);
  });

  it('passes an already-resolved body straight through', () => {
    expect(bindWorkflowParameters(positional(), { body: ['Ana', 'AO-4471'] }).body).toEqual([
      'Ana',
      'AO-4471',
    ]);
  });

  it('coerces the scalars a workflow variable actually produces', () => {
    expect(bindWorkflowParameters(positional(), { 1: 42, 2: true }).body).toEqual([
      '42',
      'true',
    ]);
  });

  /**
   * The rule that matters most here. Every one of these would otherwise reach
   * the customer as `null`, `undefined` or `[object Object]` — a message Meta
   * accepts and a person reads.
   */
  it.each([
    ['missing', {}],
    ['null', { 1: null, 2: null }],
    ['an object', { 1: { firstName: 'Ana' }, 2: [] }],
  ])('leaves %s empty so the send is refused instead', (_label, raw) => {
    expect(bindWorkflowParameters(positional(), raw).body).toEqual(['', '']);
  });

  /**
   * The builder's `Variables` field is a string, because an `object` input gets
   * no variable binding in Twenty — so the value that arrives is JSON text with
   * `{{…}}` already interpolated by the engine.
   */
  it('parses the JSON text the builder actually sends', () => {
    expect(
      bindWorkflowParameters(positional(), '{"1": "Ana", "2": "AO-4471"}').body,
    ).toEqual(['Ana', 'AO-4471']);

    expect(bindWorkflowParameters(named(), '{"nome": "Ana"}').body).toEqual(['Ana', '']);
  });

  /**
   * A typo in the JSON must not send a message with gaps in it. Empty values are
   * named missing variables, which refuses the send — the only safe reading.
   */
  it.each(['{"1": Ana}', 'Ana', '{', ''])('refuses rather than send on %p', (raw) => {
    expect(bindWorkflowParameters(positional(), raw).body).toEqual(['', '']);
  });

  it('survives a Variables input that is not an object at all', () => {
    expect(bindWorkflowParameters(positional(), null).body).toEqual(['', '']);
    expect(bindWorkflowParameters(positional(), 42).body).toEqual(['', '']);
  });
});

describe('folding the per-variable fields', () => {
  it('numbers the filled fields the way Meta numbers them', () => {
    expect(combineVariableInputs(['Ana', 'AO-4471'], undefined)).toEqual({
      1: 'Ana',
      2: 'AO-4471',
    });
  });

  /**
   * An untouched box must not become an empty variable. Five slots are always
   * sent, so counting them all would make every template with fewer than five
   * variables look like it had missing ones.
   */
  it('drops the boxes the author left alone', () => {
    expect(combineVariableInputs(['Ana', '', '   ', undefined, null], undefined)).toEqual({
      1: 'Ana',
    });
  });

  it('lets the advanced JSON override a numbered field', () => {
    expect(combineVariableInputs(['Ana'], '{"1": "Marcos", "header": "x"}')).toEqual({
      1: 'Marcos',
      header: 'x',
    });
  });

  it('adds what the numbered fields cannot express', () => {
    expect(
      combineVariableInputs(['Ana'], '{"buttons": {"0": "AO-4471"}}'),
    ).toEqual({ 1: 'Ana', buttons: { 0: 'AO-4471' } });
  });

  /**
   * An already-resolved payload replaces the fields rather than merging. Merging
   * positions into an ordered array would silently reorder someone's message.
   */
  it('lets an already-resolved body replace the fields outright', () => {
    expect(combineVariableInputs(['Ana'], { body: ['Marcos', 'X'] })).toEqual({
      body: ['Marcos', 'X'],
    });
  });

  it('binds the folded result through the spec', () => {
    const combined = combineVariableInputs(['Ana', 'AO-4471'], undefined);

    expect(bindWorkflowParameters(positional(), combined).body).toEqual([
      'Ana',
      'AO-4471',
    ]);
  });

  /** Named templates take the fields positionally, in template order. */
  it('fills a named template from the numbered fields', () => {
    const combined = combineVariableInputs(['Ana', 'AO-4471'], undefined);

    expect(bindWorkflowParameters(named(), combined).body).toEqual(['Ana', 'AO-4471']);
  });

  it('offers enough slots to be useful without being a form', () => {
    expect(BODY_VARIABLE_SLOTS).toBeGreaterThanOrEqual(4);
    expect(BODY_VARIABLE_SLOTS).toBeLessThanOrEqual(8);
  });
});

describe('binding a header', () => {
  const withHeader = (format: VariableSpec['header']) => positional({ header: format });

  const textHeader = withHeader({
    format: 'TEXT',
    variableCount: 1,
    indices: [1],
    names: [],
    text: 'Fatura {{1}}',
    example: [],
  });

  const imageHeader = withHeader({
    format: 'IMAGE',
    variableCount: 0,
    indices: [],
    names: [],
    text: null,
    example: [],
  });

  it('takes a bare value for a single-variable text header', () => {
    expect(bindWorkflowParameters(textHeader, { header: 'AO-4471' }).header).toEqual({
      kind: 'text',
      values: ['AO-4471'],
    });
  });

  /**
   * A bare string on a media header is a URL, not a media id. Meta's ids are
   * opaque digits nobody has at design time, so reading a pasted link as an id
   * would turn working input into a 131053 with no explanation.
   */
  it('reads a bare string on a media header as a URL', () => {
    expect(
      bindWorkflowParameters(imageHeader, { header: 'https://cdn.example/invoice.png' })
        .header,
    ).toEqual({
      kind: 'media',
      mediaId: null,
      fileId: null,
      filePath: null,
      fileUrl: 'https://cdn.example/invoice.png',
    });
  });

  it('takes an explicit media id when one is given', () => {
    expect(bindWorkflowParameters(imageHeader, { header: { mediaId: '998877' } }).header)
      .toEqual({
        kind: 'media',
        mediaId: '998877',
        fileId: null,
        filePath: null,
        fileUrl: null,
      });
  });

  it('omits the header entirely when the template has none', () => {
    expect(bindWorkflowParameters(positional(), { header: 'ignored' }).header).toBeUndefined();
  });
});

describe('binding buttons', () => {
  const withButton = positional({
    buttons: [
      { index: 0, type: 'URL', hasVariable: true, text: 'Ver encomenda', url: 'https://x/{{1}}' },
      { index: 1, type: 'QUICK_REPLY', hasVariable: false, text: 'Obrigado', url: null },
    ],
  });

  it('reads a map keyed by Meta’s 0-based button index', () => {
    expect(bindWorkflowParameters(withButton, { buttons: { 0: 'AO-4471' } }).buttons).toEqual([
      { index: 0, subType: 'url', value: 'AO-4471' },
    ]);
  });

  it('passes an already-shaped array through', () => {
    expect(
      bindWorkflowParameters(withButton, {
        buttons: [{ index: 0, subType: 'url', value: 'AO-4471' }],
      }).buttons,
    ).toEqual([{ index: 0, subType: 'url', value: 'AO-4471' }]);
  });

  it('binds nothing when no button takes a variable', () => {
    expect(bindWorkflowParameters(positional(), { buttons: { 0: 'x' } }).buttons).toEqual([]);
  });
});
