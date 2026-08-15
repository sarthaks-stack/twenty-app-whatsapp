import { describe, expect, it } from 'vitest';

import {
  pseudoName,
  pseudoPhone,
  pseudoUserId,
  pseudoWamid,
  redactWebhookPayload,
  scrubMediaUrl,
} from './redact';
import type { MetaWebhookBody } from './types';

const REAL_NUMBER = '244923456789';
const OTHER_NUMBER = '244911111111';
const REAL_WAMID = 'wamid.HBgMMjQ0OTIzNDU2Nzg5FQIAEhgU';

const delivery = (): MetaWebhookBody => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: OTHER_NUMBER, phone_number_id: '1234567890' },
            contacts: [{ profile: { name: 'Ana Silva' }, wa_id: REAL_NUMBER }],
            messages: [
              {
                from: REAL_NUMBER,
                id: REAL_WAMID,
                timestamp: '1786000000',
                type: 'text',
                text: { body: 'Olá, o meu número é 244923456789' },
                context: { id: 'wamid.OTHER' },
              },
            ],
          },
        },
      ],
    },
  ],
});

describe('pseudonyms', () => {
  it('are deterministic', () => {
    expect(pseudoPhone(REAL_NUMBER)).toBe(pseudoPhone(REAL_NUMBER));
    expect(pseudoWamid(REAL_WAMID)).toBe(pseudoWamid(REAL_WAMID));
    expect(pseudoName('Ana Silva')).toBe(pseudoName('Ana Silva'));
  });

  it('are distinct for distinct inputs', () => {
    expect(pseudoPhone(REAL_NUMBER)).not.toBe(pseudoPhone(OTHER_NUMBER));
  });

  it('produce a plausible +244 mobile number', () => {
    expect(pseudoPhone(REAL_NUMBER)).toMatch(/^2449\d{8}$/);
  });

  it('keep the wamid prefix so parsers still recognise the shape', () => {
    expect(pseudoWamid(REAL_WAMID)).toMatch(/^wamid\.[A-Z0-9_-]+$/);
  });
});

describe('redactWebhookPayload', () => {
  it('replaces every phone-bearing field', () => {
    const { redacted } = redactWebhookPayload(delivery());
    const value = redacted.entry?.[0].changes?.[0].value;

    expect(value?.contacts?.[0].wa_id).toBe(pseudoPhone(REAL_NUMBER));
    expect(value?.messages?.[0].from).toBe(pseudoPhone(REAL_NUMBER));
    expect(value?.metadata?.display_phone_number).toBe(pseudoPhone(OTHER_NUMBER));
  });

  /**
   * The property that matters most: if `contacts[].wa_id` and `messages[].from`
   * stopped agreeing, the fixture would describe a delivery Meta cannot send,
   * and the contact-matching tests would be testing nothing.
   */
  it('keeps wa_id and from consistent', () => {
    const { redacted } = redactWebhookPayload(delivery());
    const value = redacted.entry?.[0].changes?.[0].value;

    expect(value?.contacts?.[0].wa_id).toBe(value?.messages?.[0].from);
  });

  it('is stable across separate runs, so re-captures do not churn', () => {
    const first = JSON.stringify(redactWebhookPayload(delivery()).redacted);
    const second = JSON.stringify(redactWebhookPayload(delivery()).redacted);

    expect(first).toBe(second);
  });

  it('replaces wamids wherever they appear, including quoted-reply context', () => {
    const { redacted } = redactWebhookPayload(delivery());
    const message = redacted.entry?.[0].changes?.[0].value?.messages?.[0];

    expect(message?.id).toBe(pseudoWamid(REAL_WAMID));
    expect(message?.context?.id).toBe(pseudoWamid('wamid.OTHER'));
  });

  it('pseudonymises the WhatsApp profile name', () => {
    const { redacted } = redactWebhookPayload(delivery());

    expect(redacted.entry?.[0].changes?.[0].value?.contacts?.[0].profile?.name).toBe(
      pseudoName('Ana Silva'),
    );
  });

  it('scrubs numbers that leak into free text', () => {
    const { redacted } = redactWebhookPayload(delivery());
    const body = redacted.entry?.[0].changes?.[0].value?.messages?.[0].text?.body;

    expect(body).not.toContain(REAL_NUMBER);
    expect(body).toContain(pseudoPhone(REAL_NUMBER));
  });

  it('scrubs numbers inside Meta error details', () => {
    const { redacted } = redactWebhookPayload({
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  {
                    id: REAL_WAMID,
                    status: 'failed',
                    recipient_id: REAL_NUMBER,
                    errors: [
                      {
                        code: 131026,
                        error_data: { details: `Recipient ${REAL_NUMBER} is not on WhatsApp` },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const details =
      redacted.entry?.[0].changes?.[0].value?.statuses?.[0].errors?.[0].error_data?.details;

    expect(details).not.toContain(REAL_NUMBER);
    expect(details).toContain(pseudoPhone(REAL_NUMBER));
  });

  it('leaves non-identifying fields untouched', () => {
    const { redacted } = redactWebhookPayload(delivery());
    const value = redacted.entry?.[0].changes?.[0].value;

    expect(redacted.object).toBe('whatsapp_business_account');
    expect(redacted.entry?.[0].id).toBe('waba-1');
    expect(value?.metadata?.phone_number_id).toBe('1234567890');
    expect(value?.messages?.[0].timestamp).toBe('1786000000');
    expect(value?.messages?.[0].type).toBe('text');
  });

  it('reports what it replaced', () => {
    const { phoneMap } = redactWebhookPayload(delivery());

    expect(phoneMap.get(REAL_NUMBER)).toBe(pseudoPhone(REAL_NUMBER));
    expect(phoneMap.get(OTHER_NUMBER)).toBe(pseudoPhone(OTHER_NUMBER));
  });

  it('does not mutate the input', () => {
    const input = delivery();
    const before = JSON.stringify(input);

    redactWebhookPayload(input);

    expect(JSON.stringify(input)).toBe(before);
  });

  it('handles an empty or unrecognised payload without throwing', () => {
    expect(() => redactWebhookPayload({})).not.toThrow();
    expect(redactWebhookPayload({}).redacted).toEqual({});
  });
});

/**
 * Both of these exist only because a real capture was inspected. Meta's
 * documented samples contain neither, so hand-written fixtures would have
 * shipped the identifiers straight into the repository.
 */
describe('fields found only on real deliveries', () => {
  const realShaped = {
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [
                { profile: { name: 'Ana' }, wa_id: REAL_NUMBER, user_id: 'US.13491208655302741918' },
              ],
              messages: [
                {
                  from: REAL_NUMBER,
                  from_user_id: 'US.13491208655302741918',
                  id: REAL_WAMID,
                  type: 'audio',
                  audio: {
                    id: '987180650994148',
                    mime_type: 'audio/ogg; codecs=opus',
                    voice: true,
                    url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=987180650994148&source=webhook&ext=1786809799&hash=ATxx-AbKlf8OlOZnEEQIdxBlIux02QpDcN1HwYmiW1v_Fw',
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  } as unknown as MetaWebhookBody;

  it('pseudonymises the Meta user id on both contact and message', () => {
    const { redacted } = redactWebhookPayload(realShaped);
    const value = redacted.entry?.[0].changes?.[0].value as Record<string, any>;

    expect(value.contacts[0].user_id).toBe(pseudoUserId('US.13491208655302741918'));
    expect(value.messages[0].from_user_id).toBe(pseudoUserId('US.13491208655302741918'));
  });

  it('keeps the two user id references consistent, as wa_id and from are', () => {
    const { redacted } = redactWebhookPayload(realShaped);
    const value = redacted.entry?.[0].changes?.[0].value as Record<string, any>;

    expect(value.contacts[0].user_id).toBe(value.messages[0].from_user_id);
  });

  it('keeps whatever region prefix the identifier carries', () => {
    expect(pseudoUserId('US.13491208655302741918')).toMatch(/^US\.\d{16}$/);
    expect(pseudoUserId('AO.4213860602189482')).toMatch(/^AO\.\d{16}$/);
  });

  /**
   * The prefix is region-derived. Gating redaction on the literal `US.` seen in
   * Meta's documentation let every real Angolan identifier through unredacted.
   */
  it('redacts a non-US region prefix', () => {
    const { redacted } = redactWebhookPayload({
      entry: [
        {
          id: 'w',
          changes: [
            {
              field: 'messages',
              value: {
                contacts: [{ wa_id: REAL_NUMBER, user_id: 'AO.4213860602189482' }],
                messages: [{ from: REAL_NUMBER, from_user_id: 'AO.4213860602189482', type: 'text' }],
              },
            },
          ],
        },
      ],
    } as unknown as MetaWebhookBody);

    const value = redacted.entry?.[0].changes?.[0].value as Record<string, any>;
    expect(value.contacts[0].user_id).not.toBe('AO.4213860602189482');
    expect(value.contacts[0].user_id).toBe(pseudoUserId('AO.4213860602189482'));
    expect(value.messages[0].from_user_id).toBe(value.contacts[0].user_id);
  });

  it('redacts recipient_user_id, which only appears on status payloads', () => {
    const { redacted } = redactWebhookPayload({
      entry: [
        {
          id: 'w',
          changes: [
            {
              field: 'messages',
              value: {
                contacts: [{ wa_id: REAL_NUMBER, user_id: 'AO.4213860602189482' }],
                statuses: [
                  {
                    id: REAL_WAMID,
                    status: 'sent',
                    recipient_id: REAL_NUMBER,
                    recipient_user_id: 'AO.4213860602189482',
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as MetaWebhookBody);

    const value = redacted.entry?.[0].changes?.[0].value as Record<string, any>;
    expect(value.statuses[0].recipient_user_id).toBe(pseudoUserId('AO.4213860602189482'));
    expect(value.statuses[0].recipient_user_id).toBe(value.contacts[0].user_id);
  });

  /** Catches the next unknown key carrying the same identifier shape. */
  it('redacts a user id by value shape even under an unknown key', () => {
    const { redacted } = redactWebhookPayload({
      entry: [
        { id: 'w', changes: [{ field: 'messages', value: { some_future_key: 'BR.9988776655443322' } as any }] },
      ],
    } as unknown as MetaWebhookBody);

    expect((redacted.entry?.[0].changes?.[0].value as any).some_future_key).toBe(
      pseudoUserId('BR.9988776655443322'),
    );
  });

  it('redacts an identifier with no prefix at all', () => {
    expect(pseudoUserId('1234567890123456')).toMatch(/^\d{16}$/);
  });

  it('strips the access token from an inlined media URL but keeps its shape', () => {
    const { redacted } = redactWebhookPayload(realShaped);
    const url = (redacted.entry?.[0].changes?.[0].value as Record<string, any>).messages[0].audio.url;

    expect(url).toBe(
      'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=987180650994148',
    );
    expect(url).not.toContain('hash=');
    expect(url).not.toContain('ext=');
  });

  it('leaves unrelated urls alone', () => {
    expect(
      redactWebhookPayload({
        entry: [
          {
            id: 'w',
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [
                    { type: 'text', referral: { source_url: 'https://example.com/ad?x=1' } },
                  ],
                },
              },
            ],
          },
        ],
      }).redacted.entry?.[0].changes?.[0].value?.messages?.[0].referral?.source_url,
    ).toBe('https://example.com/ad?x=1');
  });

  it('falls back to a placeholder for an unparseable media url', () => {
    expect(scrubMediaUrl('https://lookaside.fbsbx.com/%%%')).toBeTypeOf('string');
  });
});

/**
 * A shared contact card is the highest-risk payload the app receives: it
 * carries a **third party's** identity — someone who never messaged the
 * business — including a base64 vCard repeating every name and number.
 */
describe('shared contact cards', () => {
  const card = {
    entry: [
      {
        id: 'w',
        changes: [
          {
            field: 'messages',
            value: {
              messages: [
                {
                  type: 'contacts',
                  contacts: [
                    {
                      name: {
                        first_name: 'Abel',
                        last_name: 'Febere',
                        formatted_name: 'Abel Febere',
                      },
                      phones: [
                        { phone: '+244 914 856 260', type: 'antigo' },
                        { phone: '+244931222748' },
                        { phone: '+244 952 219 394', wa_id: '244952219394', type: 'CELL' },
                      ],
                      vcard: Buffer.from(
                        'BEGIN:VCARD\nFN:Abel Febere\nTEL:+244931222748\nEND:VCARD',
                        'utf8',
                      ).toString('base64'),
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  } as unknown as MetaWebhookBody;

  const contact = () =>
    (redactWebhookPayload(card).redacted.entry?.[0].changes?.[0].value as any).messages[0]
      .contacts[0];

  it('pseudonymises every part of the third party name', () => {
    const n = contact().name;
    expect(n.first_name).not.toBe('Abel');
    expect(n.last_name).not.toBe('Febere');
    expect(n.formatted_name).not.toContain('Abel');
    expect(n.formatted_name).not.toContain('Febere');
  });

  it('redacts phone numbers written with spaces', () => {
    const phones = contact().phones.map((p: any) => p.phone);
    expect(phones.join(' ')).not.toContain('914 856 260');
    expect(phones.join(' ')).not.toContain('244914856260');
    phones.forEach((p: string) => expect(p).toMatch(/^\+2449\d{8}$/));
  });

  it('maps a spaced and an unspaced form of the same number identically', () => {
    const phones = contact().phones;
    expect(phones[2].phone).toBe(`+${phones[2].wa_id}`);
  });

  it('replaces the vCard entirely — redacting the fields alone leaves it recoverable', () => {
    const decoded = Buffer.from(contact().vcard, 'base64').toString('utf8');
    expect(decoded).not.toContain('Abel');
    expect(decoded).not.toContain('Febere');
    expect(decoded).not.toContain('244931222748');
    expect(decoded).toContain('BEGIN:VCARD');
  });
});

describe('regressions', () => {
  /**
   * `id` is excluded from phone matching so `phone_number_id` survives. An
   * early return for those keys once short-circuited the WAMID rule — and every
   * WAMID base64-embeds the contact's phone number.
   */
  it('still redacts a wamid under the key `id`', () => {
    const { redacted } = redactWebhookPayload({
      entry: [
        {
          id: 'w',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '1206450239224164' },
                messages: [
                  { id: 'wamid.HBgMMjQ0OTI4ODYzNjU5FQIAEhgU', type: 'text', timestamp: '1786809219' },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as MetaWebhookBody);

    const value = redacted.entry?.[0].changes?.[0].value as any;
    expect(value.messages[0].id).not.toContain('MjQ0OTI4ODYzNjU5');
    expect(value.messages[0].id).toMatch(/^wamid\./);
    // …while the routing id and timestamp are left intact.
    expect(value.metadata.phone_number_id).toBe('1206450239224164');
    expect(value.messages[0].timestamp).toBe('1786809219');
  });

  it('redacts phone_number, which only appears on account_update', () => {
    const { redacted } = redactWebhookPayload({
      entry: [
        { id: 'w', changes: [{ field: 'account_update', value: { phone_number: '244923456789' } as any }] },
      ],
    } as unknown as MetaWebhookBody);

    expect((redacted.entry?.[0].changes?.[0].value as any).phone_number).toBe(
      pseudoPhone('244923456789'),
    );
  });
});
