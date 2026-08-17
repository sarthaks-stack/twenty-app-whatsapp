import {
  emptyParameters,
  type ButtonParameter,
  type HeaderParameter,
  type ResolvedParameters,
} from './template-render';
import type { VariableSpec } from './template-spec';

/**
 * A workflow author's `Variables` object → `ResolvedParameters` (FR-WF-1,
 * specs/04 §3).
 *
 * The composer sends `{ body: [...], buttons: [...] }` because a React form
 * knows the template's spec and can build it. A workflow step cannot: its
 * `Variables` input is a free-form object the author fills with workflow
 * variables, and what they will naturally type is the placeholder they can see
 * in the template — `{ "1": "Ana", "2": "AO-4471" }`, or `{ "nome": "Ana" }`
 * for a named template.
 *
 * So the mapping is *by key*, and the spec is what turns keys back into the
 * positional array the sender needs. Doing it here, purely, is what makes the
 * mapping testable without a template, a workflow or a Meta account — and this
 * is the one place in the app where a caller supplies variables without ever
 * seeing the template, so a silent mis-binding would reach a customer.
 *
 * A `body` array is passed straight through. An automation that was built
 * against the route's shape, or one step feeding another, must not be
 * re-interpreted as a map of keys named `0`, `1`, `2`.
 */

const asText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  /**
   * `null`, `undefined`, objects and arrays become empty rather than
   * `"[object Object]"` or `"null"`. Empty is what `validateParameters` reports
   * as a missing variable, which refuses the send with a reason the author can
   * act on; the stringified form would be sent to the customer.
   */
  return '';
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * The keys a template's body variables answer to, in send order.
 *
 * Both forms are accepted for a positional template — `"1"` because that is
 * what the author reads in `{{1}}`, and `"0"` never, because Meta's body
 * numbering starts at one and an off-by-one here shifts every variable in the
 * message by one position.
 */
const bodyKeys = (spec: VariableSpec): string[] =>
  spec.namedParameters ? spec.body.names : spec.body.indices.map((index) => String(index));

const firstDefined = (source: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) {
    if (key in source) return source[key];
  }

  return undefined;
};

/**
 * Where a body value for `key` may be written.
 *
 * Three shapes, because three are plausible and only one of them is obvious:
 * flat at the top level (`{ "1": "Ana" }`), nested under `body`
 * (`{ body: { "1": "Ana" } }`), and — for named templates — under the token
 * with or without braces, since an author copying from the template text copies
 * `{{nome}}` along with them.
 */
const bodyValueFor = (raw: Record<string, unknown>, key: string): unknown => {
  const nested = record(raw.body);

  return (
    firstDefined(nested, [key, `{{${key}}}`]) ?? firstDefined(raw, [key, `{{${key}}}`])
  );
};

const headerFor = (
  spec: VariableSpec,
  raw: Record<string, unknown>,
): HeaderParameter | undefined => {
  const header = spec.header;
  if (header === null) return undefined;

  const supplied = raw.header;
  const isMedia = header.format !== 'TEXT' && header.format !== 'LOCATION';

  if (isMedia) {
    /**
     * A bare string is read as a URL, not as a media id. An author pasting one
     * value into a media header is pasting a link — Meta's media ids are
     * opaque digits nobody has to hand at design time, and guessing "id" would
     * turn a working URL into a 131053 nobody could explain.
     */
    if (typeof supplied === 'string' && supplied.trim().length > 0) {
      return {
        kind: 'media',
        mediaId: null,
        fileId: null,
        filePath: null,
        fileUrl: supplied.trim(),
      };
    }

    const object = record(supplied);
    const pick = (key: string): string | null => {
      const value = object[key];

      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    };

    return {
      kind: 'media',
      mediaId: pick('mediaId'),
      fileId: pick('fileId'),
      filePath: pick('filePath'),
      fileUrl: pick('fileUrl'),
    };
  }

  if (header.variableCount === 0) return undefined;

  if (Array.isArray(supplied)) {
    return { kind: 'text', values: supplied.map(asText) };
  }

  if (typeof supplied === 'string' || typeof supplied === 'number') {
    return { kind: 'text', values: [asText(supplied)] };
  }

  const keys = spec.namedParameters
    ? header.names
    : header.indices.map((index) => String(index));

  const object = record(supplied);

  return {
    kind: 'text',
    values: keys.map((key) => asText(firstDefined(object, [key, `{{${key}}}`]))),
  };
};

const buttonsFor = (spec: VariableSpec, raw: Record<string, unknown>): ButtonParameter[] => {
  const variable = spec.buttons.filter((button) => button.hasVariable);
  if (variable.length === 0) return [];

  const supplied = raw.buttons;

  /**
   * An array is taken as already-shaped `ButtonParameter`s — the composer's
   * form — and anything else as a map keyed by Meta's own 0-based button index.
   */
  if (Array.isArray(supplied)) {
    return supplied
      .map((entry) => {
        const object = record(entry);
        const index = Number(object.index);
        const subType = asText(object.subType);

        return {
          index: Number.isInteger(index) ? index : -1,
          subType: subType.length === 0 ? 'url' : subType,
          value: asText(object.value),
        };
      })
      .filter((button) => button.index >= 0);
  }

  const object = record(supplied);

  return variable.map((button) => ({
    index: button.index,
    subType: button.type.toLowerCase() === 'copy_code' ? 'copy_code' : 'url',
    value: asText(object[String(button.index)]),
  }));
};

/**
 * Binds a workflow step's `Variables` object to the template it names.
 *
 * Never throws and never guesses a value: anything it cannot find comes back
 * empty, which `validateParameters` then reports as a named missing variable —
 * so the step completes with a `denied`-shaped refusal the author can read
 * instead of sending a message with a gap in it.
 */
export const bindWorkflowParameters = (
  spec: VariableSpec,
  raw: unknown,
): ResolvedParameters => {
  const source = record(raw);
  const header = headerFor(spec, source);

  /**
   * `body` being an array means it is already resolved — a map of keys is an
   * object — and passing it through unchanged is what lets one step's output
   * feed the next.
   */
  const body = Array.isArray(source.body)
    ? source.body.map(asText)
    : bodyKeys(spec).map((key) => asText(bodyValueFor(source, key)));

  return {
    ...emptyParameters(),
    body,
    buttons: buttonsFor(spec, source),
    ...(header === undefined ? {} : { header }),
  };
};
