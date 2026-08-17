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
