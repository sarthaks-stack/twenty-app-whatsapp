import type { MessageProjection } from '../../domain/feed/projection';

/**
 * What a message carries beyond its own text (review §"hide the raw payload").
 *
 * The bubble used to answer "Ver detalhes" with `JSON.stringify(payload)` — the
 * webhook's raw object, keys and braces and all, in 8px type inside a
 * conversation. That is a developer's view of a customer's message, and it was
 * on the standard surface every rep uses.
 *
 * Almost none of it was worth showing. For most types the payload holds exactly
 * what the bubble already prints: a button reply's payload is `{id, title}` and
 * the bubble prints the title. Only three shapes carry something the body drops
 * — where a location actually is, which numbers a shared contact card holds,
 * and the second line of a list reply — so those are the three this returns,
 * and everything else returns nothing and gets no button at all.
 *
 * Pure, and keyed by copy key rather than by label, so the rows translate with
 * the rest of the surface.
 */

export type DetailRow = { key: string; value: string };

const text = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim().length === 0 ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  return null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * A shared contact card, flattened to "name · number".
 *
 * Meta nests the name three levels down and the phones in a sibling array; a
 * rep wants the pair on one line, and wants it even when only one half arrived.
 */
const contactRows = (payload: Record<string, unknown>): DetailRow[] => {
  const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];

  return contacts.flatMap((entry): DetailRow[] => {
    const contact = asRecord(entry);

    if (contact === null) return [];

    const name =
      text(asRecord(contact.name)?.formatted_name) ??
      text(asRecord(contact.name)?.first_name);

    const phones = Array.isArray(contact.phones) ? contact.phones : [];
    const number = phones
      .map((phone) => text(asRecord(phone)?.phone) ?? text(asRecord(phone)?.wa_id))
      .find((value): value is string => value !== null);

    if (name === null && number === undefined) return [];

    return [
      {
        key: 'chat.detail.contact',
        value: [name, number].filter((part) => part !== null && part !== undefined).join(' · '),
      },
    ];
  });
};

export const messageDetails = (message: MessageProjection): DetailRow[] => {
  const payload = message.payload;

  if (payload === null) return [];

  switch (message.type) {
    case 'LOCATION': {
      const address = text(payload.address);
      const latitude = text(payload.latitude);
      const longitude = text(payload.longitude);

      return [
        ...(address === null ? [] : [{ key: 'chat.detail.address', value: address }]),
        ...(latitude === null || longitude === null
          ? []
          : [{ key: 'chat.detail.coordinates', value: `${latitude}, ${longitude}` }]),
      ];
    }

    case 'CONTACTS':
      return contactRows(payload);

    case 'LIST_REPLY': {
      const description = text(payload.description);

      return description === null
        ? []
        : [{ key: 'chat.detail.description', value: description }];
    }

    default:
      return [];
  }
};
