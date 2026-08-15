import { describe, expect, it } from 'vitest';

import { classifyChange, routingKeysForChange } from './classify-change';
import type { MetaChange } from './types';

const messagesChange = (value: MetaChange['value']): MetaChange => ({
  field: 'messages',
  value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '244923000000', phone_number_id: '1234567890' },
    ...value,
  },
});

describe('classifyChange — inbound messages', () => {
  it.each([
    ['text', { type: 'text', text: { body: 'Olá' } }, 'inbound-text'],
    ['image', { type: 'image', image: { id: '1' } }, 'inbound-image'],
    ['video', { type: 'video', video: { id: '1' } }, 'inbound-video'],
    ['document', { type: 'document', document: { id: '1' } }, 'inbound-document'],
    ['location', { type: 'location', location: { latitude: 1, longitude: 2 } }, 'inbound-location'],
    ['contacts', { type: 'contacts', contacts: [] }, 'inbound-contacts'],
    ['button', { type: 'button', button: { text: 'Sim' } }, 'inbound-button'],
    ['order', { type: 'order' }, 'inbound-order'],
  ])('slugs a %s message', (_label, message, expected) => {
    expect(classifyChange(messagesChange({ messages: [message] })).slugs).toEqual([expected]);
  });

  it('distinguishes a voice note from an audio file', () => {
    expect(
      classifyChange(messagesChange({ messages: [{ type: 'audio', audio: { id: '1' } }] })).slugs,
    ).toEqual(['inbound-audio']);

    expect(
      classifyChange(
        messagesChange({ messages: [{ type: 'audio', audio: { id: '1', voice: true } }] }),
      ).slugs,
    ).toEqual(['inbound-audio-voice']);
  });

  it('distinguishes an animated sticker', () => {
    expect(
      classifyChange(
        messagesChange({ messages: [{ type: 'sticker', sticker: { id: '1', animated: true } }] }),
      ).slugs,
    ).toEqual(['inbound-sticker-animated']);
  });

  it('distinguishes adding from removing a reaction', () => {
    expect(
      classifyChange(
        messagesChange({ messages: [{ type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } }] }),
      ).slugs,
    ).toEqual(['inbound-reaction-add']);

    expect(
      classifyChange(
        messagesChange({ messages: [{ type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '' } }] }),
      ).slugs,
    ).toEqual(['inbound-reaction-remove']);
  });

  it('names interactive replies by their inner type', () => {
    expect(
      classifyChange(
        messagesChange({
          messages: [
            { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'a' } } },
          ],
        }),
      ).slugs,
    ).toEqual(['inbound-interactive-button-reply']);

    expect(
      classifyChange(
        messagesChange({
          messages: [{ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'a' } } }],
        }),
      ).slugs,
    ).toEqual(['inbound-interactive-list-reply']);
  });

  it('marks a quoted reply', () => {
    expect(
      classifyChange(
        messagesChange({ messages: [{ type: 'text', text: { body: 'sim' }, context: { id: 'wamid.X' } }] }),
      ).slugs,
    ).toEqual(['inbound-text-reply']);
  });

  /**
   * Real interactive replies always carry a `context` pointing at the message
   * that offered the buttons. Building them without one — as the original tests
   * did — hid a doubled `-reply` suffix that matched no required fixture.
   */
  it.each([
    [
      'button_reply',
      { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'a' } } },
      'inbound-interactive-button-reply',
    ],
    [
      'list_reply',
      { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'a' } } },
      'inbound-interactive-list-reply',
    ],
    [
      'template quick-reply button',
      { type: 'button', button: { text: 'Sim', payload: 'SIM' } },
      'inbound-button',
    ],
  ])('does not double the suffix for a %s carrying its intrinsic context', (_l, message, expected) => {
    expect(
      classifyChange(messagesChange({ messages: [{ ...message, context: { id: 'wamid.X' } }] })).slugs,
    ).toEqual([expected]);
  });

  it('does not add a reply suffix to a reaction, whose context is implicit', () => {
    expect(
      classifyChange(
        messagesChange({
          messages: [
            { type: 'reaction', reaction: { emoji: '👍' }, context: { id: 'wamid.X' } },
          ],
        }),
      ).slugs,
    ).toEqual(['inbound-reaction-add']);
  });

  it('marks a Click-to-WhatsApp referral', () => {
    expect(
      classifyChange(
        messagesChange({
          messages: [{ type: 'text', text: { body: 'oi' }, referral: { source_type: 'ad' } }],
        }),
      ).slugs,
    ).toEqual(['inbound-text-referral']);
  });

  it('slugs every message in a batch', () => {
    const result = classifyChange(
      messagesChange({
        messages: [{ type: 'text' }, { type: 'image', image: { id: '1' } }],
      }),
    );

    expect(result.slugs).toEqual(['inbound-text', 'inbound-image']);
    expect(result.messageCount).toBe(2);
  });
});

describe('classifyChange — statuses', () => {
  it.each(['sent', 'delivered', 'read', 'played'])('slugs a %s status', (status) => {
    expect(classifyChange(messagesChange({ statuses: [{ id: 'wamid.X', status }] })).slugs).toEqual([
      `status-${status}`,
    ]);
  });

  it('includes the Meta error code on a failure', () => {
    expect(
      classifyChange(
        messagesChange({
          statuses: [{ id: 'wamid.X', status: 'failed', errors: [{ code: 131047 }] }],
        }),
      ).slugs,
    ).toEqual(['status-failed-131047']);
  });
});

describe('classifyChange — mixed payloads', () => {
  /**
   * The property that forces the fan-out to live inside the workspace rather
   * than at the resolver (specs/00 D-2): one change carries both.
   */
  it('reports messages and statuses from a single change', () => {
    const result = classifyChange(
      messagesChange({
        messages: [{ type: 'text' }],
        statuses: [{ id: 'wamid.X', status: 'delivered' }],
      }),
    );

    expect(result.kinds).toEqual(['inbound_message', 'status']);
    expect(result.slugs).toEqual(['inbound-text', 'status-delivered']);
  });

  it('reports a value-level error only when there is nothing else', () => {
    expect(classifyChange(messagesChange({ errors: [{ code: 131000 }] })).kinds).toEqual([
      'account_error',
    ]);

    expect(
      classifyChange(messagesChange({ messages: [{ type: 'text' }], errors: [{ code: 131000 }] })).kinds,
    ).toEqual(['inbound_message']);
  });
});

describe('classifyChange — non-message fields', () => {
  it.each([
    [
      'message_template_status_update',
      { message_template_id: 1, event: 'APPROVED' },
      'template_status',
      'template-status-approved',
    ],
    [
      'message_template_quality_update',
      { message_template_id: 1, new_quality_score: 'RED' },
      'template_quality',
      'template-quality-red',
    ],
    [
      'phone_number_quality_update',
      { event: 'FLAGGED' },
      'phone_quality',
      'phone-quality-flagged',
    ],
    [
      'account_update',
      { event: 'ACCOUNT_RESTRICTION' },
      'account_update',
      'account-update-account-restriction',
    ],
    [
      'message_template_components_update',
      { message_template_id: 1, message_template_title: 'x' },
      'template_components',
      'template-components-update',
    ],
    ['account_review_update', { decision: 'APPROVED' }, 'account_review', 'account-review-approved'],
    ['phone_number_name_update', { decision: 'APPROVED' }, 'phone_name', 'phone-name-approved'],
  ])('classifies %s', (field, value, kind, slug) => {
    const result = classifyChange({ field, value });

    expect(result.kinds).toContain(kind);
    expect(result.slugs).toContain(slug);
  });

  it('falls back to unknown for an unrecognised field', () => {
    const result = classifyChange({ field: 'something_new', value: {} });

    expect(result.kinds).toEqual(['unknown']);
    expect(result.slugs).toEqual(['unknown-something-new']);
  });

  it('never returns an empty classification', () => {
    const result = classifyChange({});

    expect(result.kinds.length).toBeGreaterThan(0);
    expect(result.slugs.length).toBeGreaterThan(0);
  });
});

describe('routingKeysForChange', () => {
  it('prefers the phone number id and keeps the WABA id as a fallback', () => {
    expect(routingKeysForChange('waba-1', messagesChange({ messages: [{ type: 'text' }] }))).toEqual({
      phoneNumberId: '1234567890',
      wabaId: 'waba-1',
    });
  });

  it('yields only the WABA id for template events, which carry no phone number', () => {
    expect(
      routingKeysForChange('waba-1', {
        field: 'message_template_status_update',
        value: { event: 'APPROVED' },
      }),
    ).toEqual({ phoneNumberId: undefined, wabaId: 'waba-1' });
  });
});
