/**
 * Meta `components[]` → `whatsappTemplate.variableSpec` + the CRM support
 * verdict (FR-TPL-3, FR-TPL-4, specs/06 §2).
 *
 * Derived once at sync and stored, rather than re-parsed in the browser on
 * every render: the rules would otherwise exist twice, and the front-component
 * sandbox is the worst place to keep the second copy.
 *
 * `assessSupport` exists to design out one specific failure: a template that
 * *looks* selectable, is chosen for a 5 000-recipient campaign, and fails at
 * Meta for every single recipient because the CRM cannot fill one of its
 * components. Unsupported templates still sync and stay visible to admins with
 * an explanation — they simply cannot be picked.
 */

export type MetaTemplateButton = {
  type?: string;
  text?: string;
  url?: string;
  phone_number?: string;
  example?: string[];
  otp_type?: string;
  flow_id?: string | number;
  flow_name?: string;
};

export type MetaTemplateComponent = {
  type?: string;
  format?: string;
  text?: string;
  example?: {
    header_text?: string[];
    header_handle?: string[];
    body_text?: string[][];
    header_text_named_params?: { param_name?: string; example?: string }[];
    body_text_named_params?: { param_name?: string; example?: string }[];
  };
  buttons?: MetaTemplateButton[];
  cards?: unknown[];
  limited_time_offer?: unknown;
  add_security_recommendation?: boolean;
  code_expiration_minutes?: number;
};

export type HeaderFormat = 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';

export type HeaderSpec = {
  format: HeaderFormat;
  /** Text headers accept at most one variable; media headers accept none. */
  variableCount: number;
  indices: number[];
  names: string[];
  text: string | null;
  example: string[];
};

export type BodySpec = {
  variableCount: number;
  /** Positional placeholders, sorted. Empty when the template uses names. */
  indices: number[];
  /** Named placeholders, in first-appearance order. Empty when positional. */
  names: string[];
  text: string | null;
  example: string[];
};

export type ButtonSpec = {
  index: number;
  type: string;
  hasVariable: boolean;
  text: string | null;
  url: string | null;
};

export type VariableSpec = {
  /** Meta's newer `{{name}}` form, detected — never guessed (specs/04 §6). */
  namedParameters: boolean;
  header: HeaderSpec | null;
  body: BodySpec;
  footer: { text: string } | null;
  buttons: ButtonSpec[];
  /** Everything a sender must supply, across all components. */
  totalVariableCount: number;
};

export const UNSUPPORTED_REASON = {
  CAROUSEL: 'CAROUSEL',
  LIMITED_TIME_OFFER: 'LIMITED_TIME_OFFER',
  FLOW_BUTTON: 'FLOW_BUTTON',
  CATALOG_BUTTON: 'CATALOG_BUTTON',
  MPM_BUTTON: 'MPM_BUTTON',
  COPY_CODE_BUTTON: 'COPY_CODE_BUTTON',
  OTP_BUTTON: 'OTP_BUTTON',
  VOICE_CALL_BUTTON: 'VOICE_CALL_BUTTON',
  LOCATION_HEADER: 'LOCATION_HEADER',
  MIXED_PARAMETER_STYLES: 'MIXED_PARAMETER_STYLES',
} as const;
export type UnsupportedReason = (typeof UNSUPPORTED_REASON)[keyof typeof UNSUPPORTED_REASON];

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export type Placeholders = { indices: number[]; names: string[] };

/**
 * Every `{{…}}` in a piece of template text, split by style.
 *
 * Positional placeholders return their *indices*, not a count: `"{{1}} e {{1}}"`
 * is one variable used twice, and a mapping keyed by position must agree with
 * that or the parameter array sent to Meta is the wrong length (132000).
 */
export const extractPlaceholders = (text: string | null | undefined): Placeholders => {
  if (typeof text !== 'string') return { indices: [], names: [] };

  const indices = new Set<number>();
  const names: string[] = [];

  for (const match of text.matchAll(PLACEHOLDER)) {
    const token = match[1]!;

    if (/^\d+$/.test(token)) {
      indices.add(Number(token));
    } else if (!names.includes(token)) {
      names.push(token);
    }
  }

  return { indices: [...indices].sort((a, b) => a - b), names };
};

const componentOf = (
  components: MetaTemplateComponent[],
  type: string,
): MetaTemplateComponent | undefined =>
  components.find((component) => (component.type ?? '').toUpperCase() === type);

const HEADER_FORMATS = new Set<HeaderFormat>(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION']);

const headerFormatOf = (component: MetaTemplateComponent | undefined): HeaderFormat | null => {
  if (component === undefined) return null;
  const format = (component.format ?? 'TEXT').toUpperCase() as HeaderFormat;

  return HEADER_FORMATS.has(format) ? format : 'TEXT';
};

const namedExamples = (
  params: { param_name?: string; example?: string }[] | undefined,
): string[] => (params ?? []).map((p) => p.example ?? '');

export const deriveVariableSpec = (
  components: MetaTemplateComponent[] | null | undefined,
): VariableSpec => {
  const list = Array.isArray(components) ? components : [];

  const headerComponent = componentOf(list, 'HEADER');
  const bodyComponent = componentOf(list, 'BODY');
  const footerComponent = componentOf(list, 'FOOTER');
  const buttonsComponent = componentOf(list, 'BUTTONS');

  const headerPlaceholders = extractPlaceholders(headerComponent?.text);
  const bodyPlaceholders = extractPlaceholders(bodyComponent?.text);

  const format = headerFormatOf(headerComponent);

  const header: HeaderSpec | null =
    format === null
      ? null
      : {
          format,
          variableCount:
            format === 'TEXT'
              ? headerPlaceholders.indices.length + headerPlaceholders.names.length
              : // A media header is filled by an id or a link, not a `{{n}}` —
                // it is a required input but not a text variable, and conflating
                // the two makes the body parameter array off by one.
                0,
          indices: headerPlaceholders.indices,
          names: headerPlaceholders.names,
          text: headerComponent?.text ?? null,
          example:
            headerComponent?.example?.header_text ??
            namedExamples(headerComponent?.example?.header_text_named_params),
        };

  const body: BodySpec = {
    variableCount: bodyPlaceholders.indices.length + bodyPlaceholders.names.length,
    indices: bodyPlaceholders.indices,
    names: bodyPlaceholders.names,
    text: bodyComponent?.text ?? null,
    example:
      bodyComponent?.example?.body_text?.[0] ??
      namedExamples(bodyComponent?.example?.body_text_named_params),
  };

  const buttons: ButtonSpec[] = (buttonsComponent?.buttons ?? []).map((button, index) => {
    const url = button.url ?? null;
    const placeholders = extractPlaceholders(url);

    return {
      index,
      type: (button.type ?? 'UNKNOWN').toUpperCase(),
      hasVariable: placeholders.indices.length + placeholders.names.length > 0,
      text: button.text ?? null,
      url,
    };
  });

  const namedParameters =
    body.names.length > 0 || (header?.names.length ?? 0) > 0;

  return {
    namedParameters,
    header,
    body,
    footer: footerComponent?.text === undefined ? null : { text: footerComponent.text },
    buttons,
    totalVariableCount:
      body.variableCount +
      (header?.variableCount ?? 0) +
      buttons.filter((button) => button.hasVariable).length,
  };
};

export type SupportVerdict = {
  isUsableInCrm: boolean;
  /** The single value stored on `whatsappTemplate.unsupportedReason`. */
  unsupportedReason: UnsupportedReason | null;
  /** Everything found, for the admin-facing explanation. */
  reasons: UnsupportedReason[];
};

const BUTTON_REASONS: Record<string, UnsupportedReason> = {
  FLOW: UNSUPPORTED_REASON.FLOW_BUTTON,
  CATALOG: UNSUPPORTED_REASON.CATALOG_BUTTON,
  MPM: UNSUPPORTED_REASON.MPM_BUTTON,
  COPY_CODE: UNSUPPORTED_REASON.COPY_CODE_BUTTON,
  OTP: UNSUPPORTED_REASON.OTP_BUTTON,
  ONE_TAP: UNSUPPORTED_REASON.OTP_BUTTON,
  VOICE_CALL: UNSUPPORTED_REASON.VOICE_CALL_BUTTON,
};

export const assessSupport = (
  components: MetaTemplateComponent[] | null | undefined,
): SupportVerdict => {
  const list = Array.isArray(components) ? components : [];
  const reasons: UnsupportedReason[] = [];

  const add = (reason: UnsupportedReason): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  for (const component of list) {
    const type = (component.type ?? '').toUpperCase();

    if (type === 'CAROUSEL' || Array.isArray(component.cards)) add(UNSUPPORTED_REASON.CAROUSEL);
    if (type === 'LIMITED_TIME_OFFER' || component.limited_time_offer !== undefined) {
      add(UNSUPPORTED_REASON.LIMITED_TIME_OFFER);
    }

    if (type === 'HEADER' && headerFormatOf(component) === 'LOCATION') {
      /**
       * Not in the spec's list, added deliberately. A location header takes a
       * `{type:'location', location:{latitude,longitude,…}}` parameter, and the
       * §5 binding allow-list has no coordinate source — so the CRM cannot fill
       * it, and every send would fail. Failing closed here is exactly what
       * FR-TPL-4 asks the mechanism to do.
       */
      add(UNSUPPORTED_REASON.LOCATION_HEADER);
    }

    for (const button of component.buttons ?? []) {
      const reason = BUTTON_REASONS[(button.type ?? '').toUpperCase()];
      if (reason !== undefined) add(reason);
    }
  }

  /**
   * Meta rejects a template mixing `{{1}}` and `{{name}}`, but a synced record
   * could still carry both if a component was edited. The parameter array would
   * be built one way and validated the other, so it is refused rather than
   * half-supported.
   */
  const spec = deriveVariableSpec(list);
  const hasPositional = spec.body.indices.length + (spec.header?.indices.length ?? 0) > 0;
  const hasNamed = spec.body.names.length + (spec.header?.names.length ?? 0) > 0;
  if (hasPositional && hasNamed) add(UNSUPPORTED_REASON.MIXED_PARAMETER_STYLES);

  return {
    isUsableInCrm: reasons.length === 0,
    unsupportedReason: reasons[0] ?? null,
    reasons,
  };
};
