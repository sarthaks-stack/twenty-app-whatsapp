import { describe, expect, it } from 'vitest';

import {
  UNSUPPORTED_REASON,
  assessSupport,
  deriveVariableSpec,
  extractPlaceholders,
  type MetaTemplateComponent,
} from './template-spec';

const body = (text: string, example?: string[]): MetaTemplateComponent => ({
  type: 'BODY',
  text,
  ...(example === undefined ? {} : { example: { body_text: [example] } }),
});

describe('extractPlaceholders', () => {
  it('reads positional placeholders as indices, not a count', () => {
    // One variable used twice: a count of 2 would send Meta the wrong array
    // length and earn a 132000 for every recipient.
    expect(extractPlaceholders('Olá {{1}}, confirmamos para {{1}}')).toEqual({
      indices: [1],
      names: [],
    });
  });

  it('sorts and de-duplicates', () => {
    expect(extractPlaceholders('{{3}} {{1}} {{2}} {{1}}').indices).toEqual([1, 2, 3]);
  });

  it('reads named placeholders in first-appearance order', () => {
    expect(extractPlaceholders('Olá {{nome}}, da {{empresa}} — {{nome}}')).toEqual({
      indices: [],
      names: ['nome', 'empresa'],
    });
  });

  it('tolerates internal whitespace', () => {
    expect(extractPlaceholders('{{ 1 }}').indices).toEqual([1]);
  });

  it('ignores text that merely looks like a placeholder', () => {
    expect(extractPlaceholders('{ 1 } {{}} {{a-b}}')).toEqual({ indices: [], names: [] });
  });

  it('handles absent text', () => {
    expect(extractPlaceholders(undefined)).toEqual({ indices: [], names: [] });
  });
});

describe('deriveVariableSpec', () => {
  it('describes a plain body-only template', () => {
    const spec = deriveVariableSpec([body('Olá {{1}}, a sua encomenda {{2}} foi enviada.')]);

    expect(spec.namedParameters).toBe(false);
    expect(spec.body.indices).toEqual([1, 2]);
    expect(spec.body.variableCount).toBe(2);
    expect(spec.header).toBeNull();
    expect(spec.totalVariableCount).toBe(2);
  });

  it('reports a media header as required input but not as a text variable', () => {
    // Conflating the two makes the body parameter array off by one.
    const spec = deriveVariableSpec([
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::a'] } },
      body('Olá {{1}}'),
    ]);

    expect(spec.header).toMatchObject({ format: 'IMAGE', variableCount: 0 });
    expect(spec.body.variableCount).toBe(1);
    expect(spec.totalVariableCount).toBe(1);
  });

  it('counts a text header variable', () => {
    const spec = deriveVariableSpec([
      { type: 'HEADER', format: 'TEXT', text: 'Proposta {{1}}', example: { header_text: ['Set'] } },
      body('Olá {{1}}'),
    ]);

    expect(spec.header).toMatchObject({ format: 'TEXT', variableCount: 1, example: ['Set'] });
    expect(spec.totalVariableCount).toBe(2);
  });

  it('defaults a header with no declared format to TEXT', () => {
    expect(deriveVariableSpec([{ type: 'HEADER', text: 'Olá' }])?.header?.format).toBe('TEXT');
  });

  it('detects named parameters from the components rather than guessing', () => {
    const spec = deriveVariableSpec([
      {
        type: 'BODY',
        text: 'Olá {{nome}}',
        example: { body_text_named_params: [{ param_name: 'nome', example: 'Marcos' }] },
      },
    ]);

    expect(spec.namedParameters).toBe(true);
    expect(spec.body.names).toEqual(['nome']);
    expect(spec.body.example).toEqual(['Marcos']);
  });

  it('captures the footer and the buttons', () => {
    const spec = deriveVariableSpec([
      body('Olá {{1}}'),
      { type: 'FOOTER', text: 'Responda SAIR para deixar de receber' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Ver proposta', url: 'https://x.ao/p/{{1}}' },
          { type: 'QUICK_REPLY', text: 'Falar com alguém' },
        ],
      },
    ]);

    expect(spec.footer).toEqual({ text: 'Responda SAIR para deixar de receber' });
    expect(spec.buttons).toEqual([
      { index: 0, type: 'URL', hasVariable: true, text: 'Ver proposta', url: 'https://x.ao/p/{{1}}' },
      { index: 1, type: 'QUICK_REPLY', hasVariable: false, text: 'Falar com alguém', url: null },
    ]);
    expect(spec.totalVariableCount).toBe(2);
  });

  it('survives an empty or missing component array', () => {
    for (const input of [[], null, undefined]) {
      const spec = deriveVariableSpec(input);

      expect(spec.body.variableCount).toBe(0);
      expect(spec.totalVariableCount).toBe(0);
      expect(spec.buttons).toEqual([]);
    }
  });
});

describe('assessSupport', () => {
  const usable = [body('Olá {{1}}'), { type: 'BUTTONS' as const, buttons: [{ type: 'QUICK_REPLY' }] }];

  it('approves an ordinary template', () => {
    expect(assessSupport(usable)).toEqual({
      isUsableInCrm: true,
      unsupportedReason: null,
      reasons: [],
    });
  });

  /**
   * FR-TPL-4's whole point: an unsupported template that looked selectable
   * would be chosen for a campaign and fail at Meta for every recipient.
   */
  it.each([
    ['CAROUSEL', [{ type: 'CAROUSEL', cards: [] }], UNSUPPORTED_REASON.CAROUSEL],
    [
      'limited time offer',
      [{ type: 'LIMITED_TIME_OFFER', limited_time_offer: {} }],
      UNSUPPORTED_REASON.LIMITED_TIME_OFFER,
    ],
    [
      'Flow button',
      [{ type: 'BUTTONS', buttons: [{ type: 'FLOW', flow_id: '1' }] }],
      UNSUPPORTED_REASON.FLOW_BUTTON,
    ],
    [
      'catalog button',
      [{ type: 'BUTTONS', buttons: [{ type: 'CATALOG' }] }],
      UNSUPPORTED_REASON.CATALOG_BUTTON,
    ],
    ['MPM button', [{ type: 'BUTTONS', buttons: [{ type: 'MPM' }] }], UNSUPPORTED_REASON.MPM_BUTTON],
    [
      'copy-code button',
      [{ type: 'BUTTONS', buttons: [{ type: 'COPY_CODE' }] }],
      UNSUPPORTED_REASON.COPY_CODE_BUTTON,
    ],
    [
      'OTP button',
      [{ type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] }],
      UNSUPPORTED_REASON.OTP_BUTTON,
    ],
    [
      'one-tap OTP button',
      [{ type: 'BUTTONS', buttons: [{ type: 'ONE_TAP' }] }],
      UNSUPPORTED_REASON.OTP_BUTTON,
    ],
    [
      'voice call button',
      [{ type: 'BUTTONS', buttons: [{ type: 'VOICE_CALL' }] }],
      UNSUPPORTED_REASON.VOICE_CALL_BUTTON,
    ],
  ] as [string, MetaTemplateComponent[], string][])(
    'refuses a template with a %s',
    (_label, components, reason) => {
      const verdict = assessSupport([...components, body('Olá')]);

      expect(verdict.isUsableInCrm).toBe(false);
      expect(verdict.unsupportedReason).toBe(reason);
    },
  );

  /**
   * Not in the spec's list, added deliberately: the binding allow-list has no
   * coordinate source, so a location header is unfillable and every send would
   * fail. Failing closed is what the mechanism is for.
   */
  it('refuses a location header because no binding can fill it', () => {
    expect(assessSupport([{ type: 'HEADER', format: 'LOCATION' }]).unsupportedReason).toBe(
      UNSUPPORTED_REASON.LOCATION_HEADER,
    );
  });

  /**
   * D-34. An unrecognised header format used to be coerced to `TEXT`, so the
   * first template carrying a format Meta added later would have been derived
   * as text, declared usable, and failed at Meta for every recipient of
   * whatever campaign picked it.
   */
  it('refuses a header format it does not recognise', () => {
    const verdict = assessSupport([{ type: 'HEADER', format: 'PRODUCT' }]);

    expect(verdict.isUsableInCrm).toBe(false);
    expect(verdict.unsupportedReason).toBe(UNSUPPORTED_REASON.UNKNOWN_HEADER_FORMAT);
  });

  it('leaves the known formats usable', () => {
    for (const format of ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']) {
      expect(assessSupport([{ type: 'HEADER', format }]).isUsableInCrm, format).toBe(true);
    }
  });

  it('refuses a template mixing {{1}} and {{name}}', () => {
    expect(assessSupport([body('Olá {{nome}}, ref {{1}}')]).unsupportedReason).toBe(
      UNSUPPORTED_REASON.MIXED_PARAMETER_STYLES,
    );
  });

  it('reports every reason for the admin while storing one', () => {
    const verdict = assessSupport([
      { type: 'CAROUSEL', cards: [] },
      { type: 'BUTTONS', buttons: [{ type: 'FLOW' }] },
    ]);

    expect(verdict.reasons).toEqual([
      UNSUPPORTED_REASON.CAROUSEL,
      UNSUPPORTED_REASON.FLOW_BUTTON,
    ]);
    expect(verdict.unsupportedReason).toBe(UNSUPPORTED_REASON.CAROUSEL);
  });

  it('is case-insensitive about component and button types', () => {
    expect(assessSupport([{ type: 'buttons', buttons: [{ type: 'flow' }] }]).isUsableInCrm).toBe(
      false,
    );
  });
});
