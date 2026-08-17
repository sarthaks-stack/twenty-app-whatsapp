import type { VariableSpec } from './template-spec';

/**
 * Turning `{{4}}` into a question a rep can answer.
 *
 * The picker labelled its inputs with the raw placeholder — six boxes reading
 * `{{1}}` through `{{6}}` above a preview that still said `{{1}}` because
 * nothing had been typed yet. Nothing on that screen told anyone that `{{4}}`
 * was a date and `{{5}}` was a venue. The information existed the whole time,
 * in two places the picker never read:
 *
 * - **the body text**, which is where the placeholder *sits* — `📅 Data: {{4}}
 *   (hora de Luanda)` says exactly what belongs there;
 * - **Meta's own example values**, synced into `variableSpec.example` and
 *   already used to preview campaigns.
 *
 * Pure, and in the domain rather than in the component, because "which words
 * surround this placeholder" is a fact about the template and is worth a test.
 */

export type VariableHint = {
  /** `{{1}}` or `{{name}}` — still shown, small, as the unambiguous identity. */
  token: string;
  /**
   * The line of body text the placeholder sits in, trimmed to a readable
   * length. Null when the template stored no body text to read it from.
   */
  context: string | null;
  /** Meta's example for this parameter, shown as the input's placeholder. */
  example: string | null;
};

/** Long enough to carry a sentence's meaning, short enough to be a label. */
const CONTEXT_MAX = 80;

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * The fragment of body text a placeholder lives in.
 *
 * The enclosing *line* first, because a template's body is written in lines and
 * a line is almost always the unit of meaning — `📍 Local: {{5}}` is one line
 * and one idea. Only when that line is itself too long does this fall back to a
 * window around the token, and the window is widened to word boundaries so the
 * label never ends mid-word.
 */
export const contextFor = (
  text: string | null | undefined,
  token: string,
): string | null => {
  if (typeof text !== 'string' || text.length === 0) return null;

  const line = text.split('\n').find((candidate) => candidate.includes(token));

  if (line === undefined) return null;

  const collapsed = collapse(line);

  if (collapsed.length <= CONTEXT_MAX) return collapsed.length === 0 ? null : collapsed;

  const at = collapsed.indexOf(token);
  const half = Math.floor((CONTEXT_MAX - token.length) / 2);

  const start = Math.max(0, at - half);
  const end = Math.min(collapsed.length, at + token.length + half);

  const slice = collapsed.slice(start, end);

  /**
   * Trimmed to whole words at each cut, and only where a cut was actually
   * made — trimming an untouched edge would eat the first word of the line.
   */
  const left = start === 0 ? slice : slice.slice(slice.indexOf(' ') + 1);
  const right =
    end === collapsed.length ? left : left.slice(0, left.lastIndexOf(' '));

  return `${start === 0 ? '' : '… '}${right.trim()}${end === collapsed.length ? '' : ' …'}`;
};

/**
 * One hint per body variable, in the order the parameters array must be built.
 *
 * The order is `spec.body.indices`/`names` and not the order the placeholders
 * appear in the text — that is the contract `ResolvedParameters.body` was built
 * against, and reordering it here would fill `{{2}}` with something meant for
 * `{{1}}` (see `buildTemplateComponents`).
 */
export const bodyVariableHints = (spec: VariableSpec | null): VariableHint[] => {
  if (spec === null) return [];

  const tokens = spec.namedParameters
    ? spec.body.names.map((name) => `{{${name}}}`)
    : spec.body.indices.map((index) => `{{${index}}}`);

  return tokens.map((token, position) => {
    const example = spec.body.example[position];

    return {
      token,
      context: contextFor(spec.body.text, token),
      example:
        typeof example === 'string' && example.trim().length > 0 ? example.trim() : null,
    };
  });
};

/**
 * The variables in a **text header**, which the picker also has to collect.
 *
 * It did not, and that was the deeper half of the same bug: `validateParameters`
 * counts header and button variables, the form only ever offered body ones, and
 * a template with either could therefore *never* satisfy its own validator.
 * Filling all six visible boxes left Send disabled and a counter reading
 * "Missing: 8" with nothing on screen to fill.
 *
 * A media header is not here, because it needs a file rather than a word —
 * `mediaHeaderOf` below is its counterpart.
 */
export const headerVariableHints = (spec: VariableSpec | null): VariableHint[] => {
  const header = spec?.header ?? null;

  if (header === null || header.format !== 'TEXT' || header.variableCount === 0) {
    return [];
  }

  const tokens =
    header.names.length > 0
      ? header.names.map((name) => `{{${name}}}`)
      : header.indices.map((index) => `{{${index}}}`);

  return tokens.map((token, position) => {
    const example = header.example[position];

    return {
      token,
      context: contextFor(header.text, token),
      example:
        typeof example === 'string' && example.trim().length > 0 ? example.trim() : null,
    };
  });
};

/**
 * The media a header needs, when it needs one.
 *
 * This was the other half of the "Missing: 8" defect, and the worse half.
 * `assessSupport` only refuses a *location* header, so a template with an image
 * header syncs as usable and appears in the picker — but neither the picker nor
 * the campaign builder ever offered anywhere to put the image, while
 * `validateParameters` counted it as missing. Send was therefore permanently
 * disabled on those templates, with a counter naming a component that had no
 * field on screen. The comment above this function's sibling asserted such
 * templates "never reach the picker", which was simply not true (D-59).
 *
 * Returns null for a text header, a location header, and no header at all —
 * the three cases with no file to collect.
 */
export const mediaHeaderOf = (
  spec: VariableSpec | null,
): { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT' } | null => {
  const format = spec?.header?.format ?? null;

  if (format !== 'IMAGE' && format !== 'VIDEO' && format !== 'DOCUMENT') return null;

  /**
   * The format and nothing else. Meta's synced example for a media header is a
   * `header_handle` — an opaque upload token — so there is no example value a
   * form could usefully show, and offering one would be offering an address
   * that cannot be reused.
   */
  return { format };
};

export type ButtonVariableHint = {
  index: number;
  /** `url` or `copy_code` — what Meta's `sub_type` must say for this button. */
  subType: string;
  /** The button's own label, which is what a rep recognises it by. */
  label: string | null;
  /** The URL template, so it is obvious that only its tail is being filled. */
  url: string | null;
};

/**
 * The buttons that need a value — a dynamic URL suffix, or a copy code.
 *
 * Only the variable ones: a plain quick-reply button carries nothing to fill,
 * and offering an input for it would be a box that does nothing.
 */
export const buttonVariableHints = (spec: VariableSpec | null): ButtonVariableHint[] =>
  (spec?.buttons ?? [])
    .filter((button) => button.hasVariable)
    .map((button) => ({
      index: button.index,
      subType: button.type.toLowerCase() === 'copy_code' ? 'copy_code' : 'url',
      label: button.text,
      url: button.url,
    }));

/**
 * The buttons the customer will see, as plain labels for the preview.
 *
 * A template body that ends "responda através do botão abaixo" is describing a
 * button the preview did not draw — so the rep could not tell whether the
 * template they were about to send actually had one.
 */
export const buttonLabels = (spec: VariableSpec | null): string[] =>
  (spec?.buttons ?? [])
    .map((button) => button.text)
    .filter((text): text is string => typeof text === 'string' && text.length > 0);
