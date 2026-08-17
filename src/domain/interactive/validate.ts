/**
 * The gate an interactive message has to pass before it becomes a queued row
 * (spec §"Server hardening required").
 *
 * The send route used to accept any non-null `interactive` object and queue it.
 * That is the worst possible place to be lenient: the message becomes a
 * `QUEUED` record and an optimistic bubble, the rep believes it is on its way,
 * and it fails minutes later inside the sender with a Meta error written for a
 * developer — 100 characters over a title limit reported as "(#131009)
 * Parameter value is not valid". The builder cannot show that against the field
 * that caused it, because by then the builder is gone.
 *
 * So validation happens before the write, and every error names a field path
 * the builder can point at.
 *
 * The limits are Meta's, transcribed from the Meta-maintained Postman
 * collection for the Graph version this app targets. They are constants rather
 * than inline numbers because they *do* change — re-check them when the Graph
 * version moves (see the spec's validation limits note).
 */

export const INTERACTIVE_LIMITS = {
  HEADER: 60,
  BODY: 1024,
  FOOTER: 60,
  BUTTON_TITLE: 20,
  BUTTON_ID: 256,
  MIN_BUTTONS: 1,
  MAX_BUTTONS: 3,
  LIST_BUTTON: 20,
  ROW_TITLE: 24,
  ROW_DESCRIPTION: 72,
  ROW_ID: 200,
  SECTION_TITLE: 24,
  MAX_SECTIONS: 10,
  MAX_ROWS: 10,
} as const;

export type FieldError = { field: string; code: string; limit?: number };

export type InteractiveValidation =
  | { ok: true }
  | { ok: false; errors: FieldError[] };

export const ERROR = {
  REQUIRED: 'REQUIRED',
  TOO_LONG: 'TOO_LONG',
  TOO_FEW: 'TOO_FEW',
  TOO_MANY: 'TOO_MANY',
  DUPLICATE_ID: 'DUPLICATE_ID',
  UNSUPPORTED: 'UNSUPPORTED',
} as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const trimmed = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/**
 * One required, length-capped string, reported against its own path.
 *
 * Emptiness and over-length are separate codes because they are separate
 * mistakes with separate fixes, and a builder that showed "invalid" for both
 * would be the API error message again in a nicer font.
 */
const checkText = (
  value: unknown,
  field: string,
  limit: number,
  { required }: { required: boolean },
): FieldError[] => {
  const text = trimmed(value);

  if (text.length === 0) return required ? [{ field, code: ERROR.REQUIRED }] : [];
  if (text.length > limit) return [{ field, code: ERROR.TOO_LONG, limit }];

  return [];
};

/**
 * Meta accepts a text header on both interactive types and media headers on
 * some. This app composes text headers only, and says so rather than passing an
 * unsupported variant through to fail at the API — "rejected intentionally" is
 * the spec's wording and it is the difference between a bug and a boundary.
 */
const checkHeader = (header: unknown, field: string): FieldError[] => {
  if (header === null || header === undefined) return [];

  const record = asRecord(header);

  if (record === null) return [{ field, code: ERROR.UNSUPPORTED }];
  if (trimmed(record.type) !== 'text') return [{ field: `${field}.type`, code: ERROR.UNSUPPORTED }];

  return checkText(record.text, `${field}.text`, INTERACTIVE_LIMITS.HEADER, {
    required: true,
  });
};

const checkFooter = (footer: unknown, field: string): FieldError[] => {
  if (footer === null || footer === undefined) return [];

  const record = asRecord(footer);

  if (record === null) return [{ field, code: ERROR.UNSUPPORTED }];

  return checkText(record.text, `${field}.text`, INTERACTIVE_LIMITS.FOOTER, {
    required: true,
  });
};

/**
 * Ids must be unique *across the whole message*, not per section.
 *
 * A duplicate is not a cosmetic problem: the id is what comes back on the
 * customer's reply, so two rows sharing one makes the answer ambiguous
 * forever — and the ambiguity lands in whatever automation keyed off it, long
 * after anyone remembers sending the list.
 */
const checkUniqueIds = (
  ids: { value: string; field: string }[],
): FieldError[] => {
  const seen = new Set<string>();
  const errors: FieldError[] = [];

  for (const { value, field } of ids) {
    if (seen.has(value)) errors.push({ field, code: ERROR.DUPLICATE_ID });
    else seen.add(value);
  }

  return errors;
};

const validateButtons = (interactive: Record<string, unknown>): FieldError[] => {
  const action = asRecord(interactive.action);
  const buttons = asArray(action?.buttons);

  if (buttons.length < INTERACTIVE_LIMITS.MIN_BUTTONS) {
    return [
      {
        field: 'action.buttons',
        code: ERROR.TOO_FEW,
        limit: INTERACTIVE_LIMITS.MIN_BUTTONS,
      },
    ];
  }

  if (buttons.length > INTERACTIVE_LIMITS.MAX_BUTTONS) {
    return [
      {
        field: 'action.buttons',
        code: ERROR.TOO_MANY,
        limit: INTERACTIVE_LIMITS.MAX_BUTTONS,
      },
    ];
  }

  const errors = buttons.flatMap((entry, index) => {
    const button = asRecord(entry);
    const path = `action.buttons.${index}`;

    if (button === null || trimmed(button.type) !== 'reply') {
      return [{ field: path, code: ERROR.UNSUPPORTED }];
    }

    const reply = asRecord(button.reply);

    if (reply === null) return [{ field: `${path}.reply`, code: ERROR.REQUIRED }];

    return [
      ...checkText(reply.id, `${path}.reply.id`, INTERACTIVE_LIMITS.BUTTON_ID, {
        required: true,
      }),
      ...checkText(reply.title, `${path}.reply.title`, INTERACTIVE_LIMITS.BUTTON_TITLE, {
        required: true,
      }),
    ];
  });

  return [
    ...errors,
    ...checkUniqueIds(
      buttons.flatMap((entry, index) => {
        const id = trimmed(asRecord(asRecord(entry)?.reply)?.id);

        return id.length === 0 ? [] : [{ value: id, field: `action.buttons.${index}.reply.id` }];
      }),
    ),
  ];
};

const validateList = (interactive: Record<string, unknown>): FieldError[] => {
  const action = asRecord(interactive.action);
  const sections = asArray(action?.sections);

  const errors = checkText(action?.button, 'action.button', INTERACTIVE_LIMITS.LIST_BUTTON, {
    required: true,
  });

  if (sections.length === 0) {
    return [...errors, { field: 'action.sections', code: ERROR.TOO_FEW, limit: 1 }];
  }

  if (sections.length > INTERACTIVE_LIMITS.MAX_SECTIONS) {
    errors.push({
      field: 'action.sections',
      code: ERROR.TOO_MANY,
      limit: INTERACTIVE_LIMITS.MAX_SECTIONS,
    });
  }

  const rowIds: { value: string; field: string }[] = [];
  let rowCount = 0;

  sections.forEach((entry, sectionIndex) => {
    const section = asRecord(entry);
    const path = `action.sections.${sectionIndex}`;

    if (section === null) {
      errors.push({ field: path, code: ERROR.UNSUPPORTED });

      return;
    }

    /**
     * A section title is optional for a single-section list and required the
     * moment there are two — an untitled section in a multi-section list
     * renders as a gap the customer cannot make sense of.
     */
    errors.push(
      ...checkText(section.title, `${path}.title`, INTERACTIVE_LIMITS.SECTION_TITLE, {
        required: sections.length > 1,
      }),
    );

    const rows = asArray(section.rows);

    if (rows.length === 0) {
      errors.push({ field: `${path}.rows`, code: ERROR.TOO_FEW, limit: 1 });
    }

    rowCount += rows.length;

    rows.forEach((rowEntry, rowIndex) => {
      const row = asRecord(rowEntry);
      const rowPath = `${path}.rows.${rowIndex}`;

      if (row === null) {
        errors.push({ field: rowPath, code: ERROR.UNSUPPORTED });

        return;
      }

      errors.push(
        ...checkText(row.id, `${rowPath}.id`, INTERACTIVE_LIMITS.ROW_ID, { required: true }),
        ...checkText(row.title, `${rowPath}.title`, INTERACTIVE_LIMITS.ROW_TITLE, {
          required: true,
        }),
        ...checkText(row.description, `${rowPath}.description`, INTERACTIVE_LIMITS.ROW_DESCRIPTION, {
          required: false,
        }),
      );

      const id = trimmed(row.id);

      if (id.length > 0) rowIds.push({ value: id, field: `${rowPath}.id` });
    });
  });

  /**
   * The row cap is on the *message*, not on a section. A four-section list of
   * three rows each is over the limit even though no section is.
   */
  if (rowCount > INTERACTIVE_LIMITS.MAX_ROWS) {
    errors.push({
      field: 'action.sections',
      code: ERROR.TOO_MANY,
      limit: INTERACTIVE_LIMITS.MAX_ROWS,
    });
  }

  return [...errors, ...checkUniqueIds(rowIds)];
};

/**
 * The whole check, pure and exported so every rejection is easy to test.
 *
 * Only `button` and `list` are accepted. Product messages, CTA-URL messages and
 * Flows exist in the API and this app composes none of them; letting one
 * through untested would queue a message whose failure mode nobody has seen.
 */
export const validateInteractive = (value: unknown): InteractiveValidation => {
  const interactive = asRecord(value);

  if (interactive === null) {
    return { ok: false, errors: [{ field: 'interactive', code: ERROR.REQUIRED }] };
  }

  const type = trimmed(interactive.type);

  if (type !== 'button' && type !== 'list') {
    return { ok: false, errors: [{ field: 'type', code: ERROR.UNSUPPORTED }] };
  }

  const errors = [
    ...checkHeader(interactive.header, 'header'),
    ...checkText(asRecord(interactive.body)?.text, 'body.text', INTERACTIVE_LIMITS.BODY, {
      required: true,
    }),
    ...checkFooter(interactive.footer, 'footer'),
    ...(type === 'button' ? validateButtons(interactive) : validateList(interactive)),
  ];

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
};
