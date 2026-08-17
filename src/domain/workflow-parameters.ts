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
 * The `Variables` input is a **string** in the workflow builder, not an object.
 *
 * Twenty offers no variable binding on an `object` input, which made the one
 * field that most needs `{{trigger.record.name.firstName}}` the only one that
 * could not take it. As a multiline string the engine interpolates first and the
 * handler receives JSON text — so parsing is the top of this module rather than
 * a caller's job.
 *
 * Malformed JSON yields `{}`, which resolves every variable to empty and refuses
 * the send with each one named. That is the correct failure: a typo in the JSON
 * is exactly when an author must not have a message go out with gaps in it.
 */
const parsed = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();

  if (trimmed.length === 0) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
};

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
 * Where a body value for the variable at `position` may be written.
 *
 * Four shapes, because four are plausible and only one is obvious: flat at the
 * top level (`{ "1": "Ana" }`), nested under `body`
 * (`{ body: { "1": "Ana" } }`), under the token with or without braces — an
 * author copying from the template text copies `{{nome}}` along with them — and
 * finally by **1-based position**.
 *
 * The positional fallback is what makes a *number* work on a named template.
 * Without it `{ "1": "Ana" }` bound nothing on `{{nome}}`, which is how the
 * step's five numbered fields silently failed for every named template — they
 * can only send positions, since the builder has no way to know the names. It
 * fails safe (an unbound variable refuses the send) but it fails.
 */
const bodyValueFor = (
  raw: Record<string, unknown>,
  key: string,
  position: number,
): unknown => {
  const nested = record(raw.body);
  const keys = [key, `{{${key}}}`, String(position)];

  return firstDefined(nested, keys) ?? firstDefined(raw, keys);
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
 * How many body variables the step offers as their own labelled fields.
 *
 * The builder cannot ask the template how many it has: the input schema lives in
 * the manifest and Twenty never re-derives it from a half-filled step, so the
 * count is fixed at build time or it does not exist. Five covers essentially
 * every template Meta approves in practice, and `advancedParameters` is the
 * escape hatch for the rest — a header image, a button URL, a sixth variable.
 *
 * Five empty boxes on a template with no variables is the cost of that, and it
 * is the right way round: an author who cannot find where to type a value is
 * stuck, while an author looking at a box they do not need simply leaves it.
 */
export const BODY_VARIABLE_SLOTS = 5;

/**
 * Folds the numbered fields and the advanced JSON into one object to bind.
 *
 * Only non-empty numbered values are carried, so an untouched box neither
 * shadows a value the JSON supplies nor counts as a variable the author meant to
 * leave blank. The JSON is applied last and therefore wins on any key it names —
 * which is what makes it an override rather than a second, competing input.
 */
export const combineVariableInputs = (
  numbered: readonly unknown[],
  advanced: unknown,
): Record<string, unknown> => {
  const extra = record(parsed(advanced));

  /**
   * An advanced payload that is already resolved — a `body` array, as one step's
   * output feeding the next — replaces the numbered fields rather than merging
   * with them. Merging positions into an ordered array would silently reorder
   * someone's message.
   */
  if (Array.isArray(extra.body)) return extra;

  const byPosition: Record<string, unknown> = {};

  numbered.forEach((value, index) => {
    const text = asText(value);

    if (text.trim().length > 0) byPosition[String(index + 1)] = text;
  });

  return { ...byPosition, ...extra };
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
  const source = record(parsed(raw));
  const header = headerFor(spec, source);

  /**
   * `body` being an array means it is already resolved — a map of keys is an
   * object — and passing it through unchanged is what lets one step's output
   * feed the next.
   */
  const body = Array.isArray(source.body)
    ? source.body.map(asText)
    : bodyKeys(spec).map((key, index) => asText(bodyValueFor(source, key, index + 1)));

  return {
    ...emptyParameters(),
    body,
    buttons: buttonsFor(spec, source),
    ...(header === undefined ? {} : { header }),
  };
};
