import { describe, expect, it } from 'vitest';

import { buildDedupKey, buildItemDedupKeys, type DedupKeyInput } from './dedup-key';
import type { MetaChange } from './webhook/types';

const input = (change: MetaChange, entryTime = 1786811304): DedupKeyInput => ({
  entryId: '2129199877947066',
  entryTime,
  change,
});

const messagesChange = (messages: unknown[]): MetaChange => ({
  field: 'messages',
  value: {
    metadata: { phone_number_id: '1206450239224164' },
    messages: messages as never,
  },
});

const statusesChange = (statuses: unknown[]): MetaChange => ({
  field: 'messages',
  value: {
    metadata: { phone_number_id: '1206450239224164' },
    statuses: statuses as never,
  },
});

describe('inbound messages', () => {
  it('keys a single message on its wamid', () => {
    expect(buildDedupKey(input(messagesChange([{ id: 'wamid.ABC' }])))).toBe('msg:wamid.ABC');
  });

  it('is stable across a retry of the identical delivery', () => {
    const change = messagesChange([{ id: 'wamid.ABC', text: { body: 'Olá' } }]);

    expect(buildDedupKey(input(change))).toBe(buildDedupKey(input(change)));
  });

  it('distinguishes two different messages', () => {
    expect(buildDedupKey(input(messagesChange([{ id: 'wamid.A' }])))).not.toBe(
      buildDedupKey(input(messagesChange([{ id: 'wamid.B' }]))),
    );
  });
});

describe('statuses', () => {
  it('folds the status value into the key so a lifecycle is three rows, not one', () => {
    const keys = ['sent', 'delivered', 'read'].map((status) =>
      buildDedupKey(input(statusesChange([{ id: 'wamid.A', status }]))),
    );

    expect(keys).toEqual(['st:wamid.A:sent', 'st:wamid.A:delivered', 'st:wamid.A:read']);
    expect(new Set(keys).size).toBe(3);
  });

  it('separates two distinct failures of the same message by error code', () => {
    const rateLimited = statusesChange([
      { id: 'wamid.A', status: 'failed', errors: [{ code: 130429 }] },
    ]);
    const policy = statusesChange([
      { id: 'wamid.A', status: 'failed', errors: [{ code: 131049 }] },
    ]);

    expect(buildDedupKey(input(rateLimited))).toBe('st:wamid.A:failed:130429');
    expect(buildDedupKey(input(policy))).toBe('st:wamid.A:failed:131049');
  });

  it('still keys a failure with no error payload', () => {
    expect(buildDedupKey(input(statusesChange([{ id: 'wamid.A', status: 'failed' }])))).toBe(
      'st:wamid.A:failed',
    );
  });
});

describe('multi-item changes', () => {
  /**
   * The spec table gives per-item keys but specs/03 §3 stores one row per
   * change. These are the tests that pin the reconciliation.
   */
  it('digests a batch into one stable key', () => {
    const change = statusesChange([
      { id: 'wamid.A', status: 'sent' },
      { id: 'wamid.B', status: 'delivered' },
    ]);

    const key = buildDedupKey(input(change));

    expect(key).toMatch(/^multi:[0-9a-f]{32}$/);
    expect(buildDedupKey(input(change))).toBe(key);
  });

  it('changes the key when the batch membership changes', () => {
    const two = statusesChange([
      { id: 'wamid.A', status: 'sent' },
      { id: 'wamid.B', status: 'sent' },
    ]);
    const three = statusesChange([
      { id: 'wamid.A', status: 'sent' },
      { id: 'wamid.B', status: 'sent' },
      { id: 'wamid.C', status: 'sent' },
    ]);

    expect(buildDedupKey(input(two))).not.toBe(buildDedupKey(input(three)));
  });

  it('exposes the readable per-item keys', () => {
    expect(
      buildItemDedupKeys(
        input(
          statusesChange([
            { id: 'wamid.A', status: 'sent' },
            { id: 'wamid.B', status: 'delivered' },
          ]),
        ),
      ),
    ).toEqual(['st:wamid.A:sent', 'st:wamid.B:delivered']);
  });

  it('keys messages before statuses when a change carries both', () => {
    const change: MetaChange = {
      field: 'messages',
      value: {
        messages: [{ id: 'wamid.M' }],
        statuses: [{ id: 'wamid.S', status: 'sent' }],
      },
    };

    expect(buildItemDedupKeys(input(change))).toEqual(['msg:wamid.M', 'st:wamid.S:sent']);
  });
});

describe('template events', () => {
  const statusUpdate = (event: string): MetaChange => ({
    field: 'message_template_status_update',
    value: { message_template_id: 12345678, event, message_template_name: 'proposta' },
  });

  it('keys on template id, event and entry time', () => {
    expect(buildDedupKey(input(statusUpdate('APPROVED'), 1786811304))).toBe(
      'tpl:12345678:status:approved:1786811304',
    );
  });

  it('separates approval from a later rejection', () => {
    expect(buildDedupKey(input(statusUpdate('APPROVED'), 100))).not.toBe(
      buildDedupKey(input(statusUpdate('REJECTED'), 200)),
    );
  });

  it('keys quality updates on the new score', () => {
    expect(
      buildDedupKey(
        input(
          {
            field: 'message_template_quality_update',
            value: {
              message_template_id: 12345678,
              previous_quality_score: 'GREEN',
              new_quality_score: 'YELLOW',
            },
          },
          1786811295,
        ),
      ),
    ).toBe('tpl:12345678:quality:yellow:1786811295');
  });

  it('keeps a GREEN → YELLOW → GREEN → YELLOW oscillation as four distinct rows', () => {
    const quality = (score: string, time: number) =>
      buildDedupKey(
        input(
          {
            field: 'message_template_quality_update',
            value: { message_template_id: 1, new_quality_score: score },
          },
          time,
        ),
      );

    const keys = [
      quality('GREEN', 100),
      quality('YELLOW', 200),
      quality('GREEN', 300),
      quality('YELLOW', 400),
    ];

    expect(new Set(keys).size).toBe(4);
  });
});

describe('account events', () => {
  /**
   * `account_review_update` carries a single field and nothing else — verified
   * against Meta's own dashboard sample. Without `entry.time` in the key, a
   * second review with the same verdict would be discarded as a duplicate.
   */
  const review = (time: number): DedupKeyInput =>
    input({ field: 'account_review_update', value: { decision: 'APPROVED' } }, time);

  it('keys on the WABA id when there is no phone_number_id', () => {
    expect(buildDedupKey(review(1786811273))).toMatch(
      /^acct:2129199877947066:account_review_update:[0-9a-f]{16}$/,
    );
  });

  it('is stable for a retry and distinct for a later identical verdict', () => {
    expect(buildDedupKey(review(100))).toBe(buildDedupKey(review(100)));
    expect(buildDedupKey(review(100))).not.toBe(buildDedupKey(review(200)));
  });

  it('prefers the phone_number_id when the payload has one', () => {
    const key = buildDedupKey(
      input({
        field: 'phone_number_quality_update',
        value: {
          metadata: { phone_number_id: '1206450239224164' },
          event: 'ONBOARDING',
        },
      }),
    );

    expect(key.startsWith('acct:1206450239224164:phone_number_quality_update:')).toBe(true);
  });
});

describe('fallbacks', () => {
  it('hashes an unrecognised field rather than dropping it', () => {
    expect(
      buildDedupKey(input({ field: 'some_future_field', value: { decision: 'X' } })),
    ).toMatch(/^raw:[0-9a-f]{32}$/);
  });

  it('is insensitive to key ordering within the value', () => {
    const a = buildDedupKey(input({ field: 'future', value: { a: 1, b: 2 } as never }));
    const b = buildDedupKey(input({ field: 'future', value: { b: 2, a: 1 } as never }));

    expect(a).toBe(b);
  });

  it('keys an account-level error block', () => {
    const key = buildDedupKey(
      input({
        field: 'messages',
        value: {
          metadata: { phone_number_id: '123' },
          errors: [{ code: 131031, title: 'Account restricted' }],
        },
      }),
    );

    expect(key).toBe('acct-err:123:131031:1786811304');
  });

  it('never returns an empty key for an empty change', () => {
    expect(buildDedupKey(input({}))).toMatch(/^raw:[0-9a-f]{32}$/);
  });
});
