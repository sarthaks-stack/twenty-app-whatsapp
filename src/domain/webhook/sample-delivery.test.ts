import { describe, expect, it } from 'vitest';

import { isMetaSampleDelivery } from './sample-delivery';
import type { MetaWebhookBody } from './types';

/** Captured verbatim from Meta's dashboard "Test" button on 2026-08-15. */
const dashboardSample: MetaWebhookBody = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '0',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '16505551111', phone_number_id: '123456123' },
            contacts: [{ profile: { name: 'test user name' }, wa_id: '16315551181' }],
            messages: [
              {
                from: '16315551181',
                id: 'ABGGFlA5Fpa',
                timestamp: '1504902988',
                type: 'text',
                text: { body: 'this is a text message' },
              },
            ],
          },
        },
      ],
    },
  ],
};

const realDelivery: MetaWebhookBody = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '102290129340398',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '244923111222', phone_number_id: '106540352242922' },
            contacts: [{ profile: { name: 'Ana' }, wa_id: '244923456789' }],
            messages: [
              {
                from: '244923456789',
                id: 'wamid.HBgMMjQ0OTIzNDU2Nzg5FQIAEhgU',
                timestamp: '1786000000',
                type: 'text',
                text: { body: 'Olá' },
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('isMetaSampleDelivery', () => {
  it('recognises the dashboard test payload', () => {
    expect(isMetaSampleDelivery(dashboardSample)).toBe(true);
  });

  it('does not flag a real delivery', () => {
    expect(isMetaSampleDelivery(realDelivery)).toBe(false);
  });

  it.each([
    ['the placeholder entry id', { entry: [{ id: '0', changes: [] }] }],
    [
      'the sample phone_number_id',
      {
        entry: [
          {
            id: '102290129340398',
            changes: [{ field: 'messages', value: { metadata: { phone_number_id: '123456123' } } }],
          },
        ],
      },
    ],
    [
      'a message id without the wamid prefix',
      {
        entry: [
          {
            id: '102290129340398',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: '106540352242922' },
                  messages: [{ id: 'ABGGFlA5Fpa', type: 'text' }],
                },
              },
            ],
          },
        ],
      },
    ],
    [
      'a status id without the wamid prefix',
      {
        entry: [
          {
            id: '102290129340398',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: '106540352242922' },
                  statuses: [{ id: 'ABGGFlA5Fpa', status: 'delivered' }],
                },
              },
            ],
          },
        ],
      },
    ],
  ])('detects it by %s', (_label, body) => {
    expect(isMetaSampleDelivery(body as MetaWebhookBody)).toBe(true);
  });

  it('does not flag non-message events, which carry no message ids', () => {
    expect(
      isMetaSampleDelivery({
        entry: [
          {
            id: '102290129340398',
            changes: [
              { field: 'message_template_status_update', value: { event: 'APPROVED' } },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it('does not flag an empty or unrecognised payload', () => {
    expect(isMetaSampleDelivery({})).toBe(false);
    expect(isMetaSampleDelivery({ entry: [] })).toBe(false);
  });
});
