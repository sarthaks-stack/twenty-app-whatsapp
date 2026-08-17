import { INTERACTIVE_LIMITS } from './validate';

/**
 * What the builders edit, and the one function that turns it into Meta's shape.
 *
 * The alternative — letting the quick-reply form assemble
 * `{type:'button', action:{buttons:[{type:'reply', reply:{…}}]}}` inline — puts
 * a wire format inside a React component, where the validator cannot see it and
 * a test cannot reach it without a DOM. Here it is a pure function over a plain
 * draft, so "what the builder produces" and "what the route validates" are the
 * same object checked by the same module.
 *
 * The draft keeps empty strings rather than nulls because it is bound to
 * controlled inputs; `toInteractive` is what decides an empty optional field is
 * absent rather than present-and-blank. Meta rejects `header: {type:'text',
 * text:''}` — an empty optional must be *omitted*, not emptied.
 */

export type ButtonDraft = { id: string; title: string };

export type RowDraft = { id: string; title: string; description: string };

export type SectionDraft = { title: string; rows: RowDraft[] };

export type InteractiveDraft =
  | {
      kind: 'buttons';
      header: string;
      body: string;
      footer: string;
      buttons: ButtonDraft[];
    }
  | {
      kind: 'list';
      header: string;
      body: string;
      footer: string;
      buttonText: string;
      sections: SectionDraft[];
    };

/**
 * A stable, opaque id for a button or row.
 *
 * Opaque because the id is what a customer's reply carries back, and an id
 * derived from the title ("sim", "opcao-b") silently changes meaning the moment
 * someone fixes a typo in the label — every automation keyed to the old string
 * stops matching, with nothing to notice. The seed makes ids reproducible in a
 * test without reaching for a clock the sandbox may not have.
 */
export const newInteractiveId = (prefix: 'btn' | 'row', seed?: string): string => {
  const random =
    seed ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  return `${prefix}_${random}`.slice(0, INTERACTIVE_LIMITS.ROW_ID);
};

export const emptyButtonsDraft = (): InteractiveDraft => ({
  kind: 'buttons',
  header: '',
  body: '',
  footer: '',
  buttons: [{ id: newInteractiveId('btn'), title: '' }],
});

export const emptyListDraft = (): InteractiveDraft => ({
  kind: 'list',
  header: '',
  body: '',
  footer: '',
  buttonText: '',
  sections: [{ title: '', rows: [{ id: newInteractiveId('row'), title: '', description: '' }] }],
});

const trimmed = (value: string): string => value.trim();

const optionalHeader = (header: string): Record<string, unknown> =>
  trimmed(header).length === 0 ? {} : { header: { type: 'text', text: trimmed(header) } };

const optionalFooter = (footer: string): Record<string, unknown> =>
  trimmed(footer).length === 0 ? {} : { footer: { text: trimmed(footer) } };

export const toInteractive = (draft: InteractiveDraft): Record<string, unknown> => {
  if (draft.kind === 'buttons') {
    return {
      type: 'button',
      ...optionalHeader(draft.header),
      body: { text: trimmed(draft.body) },
      ...optionalFooter(draft.footer),
      action: {
        buttons: draft.buttons.map((button) => ({
          type: 'reply',
          reply: { id: button.id, title: trimmed(button.title) },
        })),
      },
    };
  }

  return {
    type: 'list',
    ...optionalHeader(draft.header),
    body: { text: trimmed(draft.body) },
    ...optionalFooter(draft.footer),
    action: {
      button: trimmed(draft.buttonText),
      sections: draft.sections.map((section) => ({
        ...(trimmed(section.title).length === 0 ? {} : { title: trimmed(section.title) }),
        rows: section.rows.map((row) => ({
          id: row.id,
          title: trimmed(row.title),
          ...(trimmed(row.description).length === 0
            ? {}
            : { description: trimmed(row.description) }),
        })),
      })),
    },
  };
};

/** Total rows across every section — the number Meta caps, and the builder shows. */
export const rowCount = (draft: InteractiveDraft): number =>
  draft.kind === 'list'
    ? draft.sections.reduce((total, section) => total + section.rows.length, 0)
    : draft.buttons.length;

/**
 * Move an item within an array, returning a new one.
 *
 * Reordering exists as explicit Move up/Move down actions because Twenty's
 * front-component sandbox drops drag `dataTransfer` payloads — a drag-only list
 * is a list that cannot be reordered at all, and it fails silently.
 */
export const moveItem = <T>(items: T[], from: number, to: number): T[] => {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }

  const next = [...items];
  const [item] = next.splice(from, 1);

  next.splice(to, 0, item!);

  return next;
};
