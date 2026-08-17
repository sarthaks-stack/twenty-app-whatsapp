import { describe, expect, it } from 'vitest';

import {
  emptyButtonsDraft,
  emptyListDraft,
  moveItem,
  newInteractiveId,
  rowCount,
  toInteractive,
} from './draft';
import { ERROR, INTERACTIVE_LIMITS, validateInteractive } from './validate';

/**
 * Every rejection below used to be a `QUEUED` row, an optimistic bubble and a
 * Meta error minutes later. The point of the suite is that the builder can
 * point at the field, so each assertion checks the *path* as well as the code.
 */

const buttons = (overrides: Record<string, unknown> = {}) => ({
  type: 'button',
  body: { text: 'Confirma a morada?' },
  action: {
    buttons: [{ type: 'reply', reply: { id: 'btn_1', title: 'Sim' } }],
  },
  ...overrides,
});

const list = (overrides: Record<string, unknown> = {}) => ({
  type: 'list',
  body: { text: 'Escolha um plano' },
  action: {
    button: 'Ver opções',
    sections: [{ title: 'Planos', rows: [{ id: 'row_1', title: 'Starter' }] }],
  },
  ...overrides,
});

const errorsOf = (value: unknown) => {
  const result = validateInteractive(value);

  return result.ok ? [] : result.errors;
};

describe('validateInteractive', () => {
  it('accepts the smallest valid message of each type', () => {
    expect(validateInteractive(buttons())).toEqual({ ok: true });
    expect(validateInteractive(list())).toEqual({ ok: true });
  });

  it('refuses a type this app does not compose, rather than passing it through', () => {
    expect(errorsOf({ type: 'product', body: { text: 'x' } })).toEqual([
      { field: 'type', code: ERROR.UNSUPPORTED },
    ]);
    expect(errorsOf(null)).toEqual([{ field: 'interactive', code: ERROR.REQUIRED }]);
  });

  it('requires a body, because Meta does', () => {
    expect(errorsOf(buttons({ body: { text: '   ' } }))).toContainEqual({
      field: 'body.text',
      code: ERROR.REQUIRED,
    });
  });

  it('reports over-length against the field and its limit', () => {
    expect(
      errorsOf(
        buttons({
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'btn_1', title: 'x'.repeat(21) } },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        field: 'action.buttons.0.reply.title',
        code: ERROR.TOO_LONG,
        limit: INTERACTIVE_LIMITS.BUTTON_TITLE,
      },
    ]);
  });

  it('holds the reply-button range the provider guard also holds', () => {
    expect(errorsOf(buttons({ action: { buttons: [] } }))).toEqual([
      { field: 'action.buttons', code: ERROR.TOO_FEW, limit: 1 },
    ]);

    const four = Array.from({ length: 4 }, (_, index) => ({
      type: 'reply',
      reply: { id: `btn_${index}`, title: 'Sim' },
    }));

    expect(errorsOf(buttons({ action: { buttons: four } }))).toEqual([
      { field: 'action.buttons', code: ERROR.TOO_MANY, limit: 3 },
    ]);
  });

  /**
   * The id is what a customer's reply carries back. Two rows sharing one makes
   * every future answer ambiguous, and the ambiguity lands in an automation
   * long after anyone remembers sending the list.
   */
  it('refuses duplicate ids across the whole message', () => {
    expect(
      errorsOf(
        list({
          action: {
            button: 'Ver',
            sections: [
              { title: 'A', rows: [{ id: 'row_1', title: 'Um' }] },
              { title: 'B', rows: [{ id: 'row_1', title: 'Dois' }] },
            ],
          },
        }),
      ),
    ).toContainEqual({
      field: 'action.sections.1.rows.0.id',
      code: ERROR.DUPLICATE_ID,
    });
  });

  it('caps rows on the message, not on a section', () => {
    const sections = Array.from({ length: 4 }, (_, section) => ({
      title: `S${section}`,
      rows: Array.from({ length: 3 }, (_, row) => ({
        id: `row_${section}_${row}`,
        title: 'Linha',
      })),
    }));

    expect(errorsOf(list({ action: { button: 'Ver', sections } }))).toContainEqual({
      field: 'action.sections',
      code: ERROR.TOO_MANY,
      limit: INTERACTIVE_LIMITS.MAX_ROWS,
    });
  });

  it('requires a section title only once there is more than one section', () => {
    expect(
      validateInteractive(
        list({ action: { button: 'Ver', sections: [{ rows: [{ id: 'r', title: 'Um' }] }] } }),
      ),
    ).toEqual({ ok: true });

    expect(
      errorsOf(
        list({
          action: {
            button: 'Ver',
            sections: [
              { rows: [{ id: 'r1', title: 'Um' }] },
              { rows: [{ id: 'r2', title: 'Dois' }] },
            ],
          },
        }),
      ),
    ).toContainEqual({ field: 'action.sections.0.title', code: ERROR.REQUIRED });
  });

  it('rejects a media header intentionally rather than letting Meta refuse it', () => {
    expect(
      errorsOf(buttons({ header: { type: 'image', image: { id: '1' } } })),
    ).toEqual([{ field: 'header.type', code: ERROR.UNSUPPORTED }]);
  });

  it('reports every field at once, so a builder can show them together', () => {
    const errors = errorsOf(
      buttons({
        body: { text: '' },
        footer: { text: 'x'.repeat(61) },
        action: { buttons: [{ type: 'reply', reply: { id: '', title: '' } }] },
      }),
    );

    expect(errors.map((error) => error.field)).toEqual([
      'body.text',
      'footer.text',
      'action.buttons.0.reply.id',
      'action.buttons.0.reply.title',
    ]);
  });
});

describe('toInteractive', () => {
  it('omits an empty optional rather than sending it blank', () => {
    const draft = emptyButtonsDraft();

    const payload = toInteractive({
      ...draft,
      kind: 'buttons',
      body: 'Confirma?',
      buttons: [{ id: 'btn_1', title: 'Sim' }],
    });

    // Meta rejects `header: {type:'text', text:''}`; an absent optional must
    // be absent, not empty.
    expect(payload).not.toHaveProperty('header');
    expect(payload).not.toHaveProperty('footer');
    expect(validateInteractive(payload)).toEqual({ ok: true });
  });

  it('produces exactly what the route validates, for both types', () => {
    expect(
      validateInteractive(
        toInteractive({
          kind: 'list',
          header: 'Planos',
          body: 'Escolha um',
          footer: 'Pixel',
          buttonText: 'Ver opções',
          sections: [
            { title: 'Planos', rows: [{ id: 'row_1', title: 'Starter', description: '' }] },
          ],
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('trims, so a trailing space cannot pass a length limit it should fail', () => {
    const payload = toInteractive({
      kind: 'buttons',
      header: '',
      body: '  Confirma?  ',
      footer: '',
      buttons: [{ id: 'btn_1', title: ' Sim ' }],
    });

    expect((payload.body as { text: string }).text).toBe('Confirma?');
  });
});

describe('the draft helpers', () => {
  it('generates opaque ids, never ids derived from the label', () => {
    const id = newInteractiveId('row', 'abc');

    expect(id).toBe('row_abc');
    expect(newInteractiveId('btn')).not.toBe(newInteractiveId('btn'));
  });

  it('counts rows across sections, which is the number Meta caps', () => {
    expect(rowCount(emptyListDraft())).toBe(1);
    expect(rowCount(emptyButtonsDraft())).toBe(1);
  });

  /** Twenty drops drag `dataTransfer`, so reordering is explicit or absent. */
  it('moves an item without mutating the array it was given', () => {
    const items = ['a', 'b', 'c'];

    expect(moveItem(items, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(items).toEqual(['a', 'b', 'c']);
    expect(moveItem(items, 0, -1)).toBe(items);
    expect(moveItem(items, 0, 9)).toBe(items);
  });
});
