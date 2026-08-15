import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LF_ACCOUNT_EVENT,
  LF_INBOUND_PROCESSOR,
  LF_STATUS_PROCESSOR,
  LF_TEMPLATE_EVENT,
} from '../constants/universal-identifiers';
import { WINDOW_KIND } from '../domain/constants';
import type { MetaChange, MetaWebhookBody } from '../domain/webhook/types';
import { matchesKeyword, windowForMessage } from './wa-inbound-processor';
import { isInlineUrlUsable, retryDelayMs, storageFilename } from './wa-media-worker';
import { ORPHAN_GRACE_MS, isRecentEnoughToRetry } from './wa-status-processor';
import { componentsFromUpdate } from './wa-template-event';
import { STATUS_BATCH_SIZE, jobsForChange } from './wa-webhook-ingest';
import { decideVerification } from './wa-webhook-verify';
import { routingKeys } from './wa-webhook-resolver';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const fanOut = (change: MetaChange) =>
  jobsForChange({
    change,
    webhookEventId: 'evt-1',
    accountId: 'acc-1',
    correlationId: 'key-1',
  });

const targets = (change: MetaChange) =>
  fanOut(change).map((job) => job.logicFunctionUniversalIdentifier);

describe('wa-webhook-verify', () => {
  const TOKEN = 'a'.repeat(64);
  const accepts = (provided: string) => provided === TOKEN;

  it('echoes the bare challenge on a valid handshake', () => {
    expect(
      decideVerification(
        { 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '12345' },
        accepts,
      ),
    ).toEqual({ status: 200, body: '12345' });
  });

  it('rejects a wrong token with 403', () => {
    expect(
      decideVerification(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' },
        accepts,
      ).status,
    ).toBe(403);
  });

  it.each([
    ['wrong mode', { 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1' }],
    ['missing token', { 'hub.mode': 'subscribe', 'hub.challenge': '1' }],
    ['missing challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN }],
    ['empty challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '' }],
    ['nothing at all', {}],
  ])('rejects %s with 400', (_label, query) => {
    expect(decideVerification(query, accepts).status).toBe(400);
  });

  /** A 400 must not be reachable by a token guess: shape is checked first. */
  it('never returns the expected token in any response', () => {
    for (const query of [{}, { 'hub.mode': 'subscribe', 'hub.verify_token': 'x' }]) {
      expect(decideVerification(query, accepts).body).not.toContain(TOKEN);
    }
  });
});

describe('workspace routing keys', () => {
  it('prefers the phone number and keeps the WABA as a fallback', () => {
    const body: MetaWebhookBody = {
      entry: [
        {
          id: 'waba-1',
          changes: [
            { field: 'messages', value: { metadata: { phone_number_id: 'pn-1' } } },
          ],
        },
      ],
    };

    expect(routingKeys(body)).toEqual(['wa:phone-number:pn-1', 'wa:waba:waba-1']);
  });

  /**
   * Template and account events carry no phone_number_id at all, so a
   * phone-only resolver would drop every template approval as unclaimed.
   */
  it('routes a template event on the WABA alone', () => {
    expect(
      routingKeys({
        entry: [
          {
            id: 'waba-1',
            changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED' } }],
          },
        ],
      }),
    ).toEqual(['wa:waba:waba-1']);
  });

  it('de-duplicates keys across changes', () => {
    expect(
      routingKeys({
        entry: [
          {
            id: 'waba-1',
            changes: [
              { field: 'messages', value: { metadata: { phone_number_id: 'pn-1' } } },
              { field: 'messages', value: { metadata: { phone_number_id: 'pn-1' } } },
            ],
          },
        ],
      }),
    ).toEqual(['wa:phone-number:pn-1', 'wa:waba:waba-1']);
  });

  it('returns nothing for an empty body', () => {
    expect(routingKeys({})).toEqual([]);
  });
});

describe('ingest fan-out', () => {
  it('enqueues one job per inbound message', () => {
    const jobs = fanOut({
      field: 'messages',
      value: { messages: [{ id: 'wamid.A' }, { id: 'wamid.B' }] },
    });

    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.logicFunctionUniversalIdentifier === LF_INBOUND_PROCESSOR)).toBe(
      true,
    );
    expect(jobs.map((job) => job.correlationId)).toEqual(['wamid.A', 'wamid.B']);
  });

  it('passes the contacts block to every message job', () => {
    const jobs = fanOut({
      field: 'messages',
      value: {
        contacts: [{ profile: { name: 'Ana' }, wa_id: '244917164819' }],
        messages: [{ id: 'wamid.A' }],
      },
    });

    expect(jobs[0]!.payload).toMatchObject({
      contacts: [{ profile: { name: 'Ana' } }],
      accountId: 'acc-1',
      webhookEventId: 'evt-1',
    });
  });

  it('batches statuses at 50', () => {
    const jobs = fanOut({
      field: 'messages',
      value: {
        statuses: Array.from({ length: 120 }, (_u, i) => ({
          id: `wamid.${i}`,
          status: 'sent' as const,
        })),
      },
    });

    expect(jobs).toHaveLength(3);
    expect(
      jobs.map((job) => (job.payload as { statuses: unknown[] }).statuses.length),
    ).toEqual([STATUS_BATCH_SIZE, STATUS_BATCH_SIZE, 20]);
  });

  /**
   * The reason the fan-out lives inside the workspace rather than in the
   * resolver: one change can be several kinds of event at once.
   */
  it('enqueues both processors when a change carries messages and statuses', () => {
    expect(
      targets({
        field: 'messages',
        value: {
          messages: [{ id: 'wamid.M' }],
          statuses: [{ id: 'wamid.S', status: 'delivered' }],
        },
      }),
    ).toEqual([LF_INBOUND_PROCESSOR, LF_STATUS_PROCESSOR]);
  });

  it('routes an account-level error block to the status processor', () => {
    const jobs = fanOut({ field: 'messages', value: { errors: [{ code: 131031 }] } });

    expect(jobs[0]!.logicFunctionUniversalIdentifier).toBe(LF_STATUS_PROCESSOR);
    expect(jobs[0]!.payload).toMatchObject({ kind: 'accountError' });
  });

  it('does not raise an account error when there are messages to explain it', () => {
    expect(
      targets({
        field: 'messages',
        value: { messages: [{ id: 'wamid.A' }], errors: [{ code: 131052 }] },
      }),
    ).toEqual([LF_INBOUND_PROCESSOR]);
  });

  it.each([
    'message_template_status_update',
    'message_template_quality_update',
    'message_template_components_update',
  ])('routes %s to the template processor', (field) => {
    expect(targets({ field, value: { message_template_id: 1 } })).toEqual([LF_TEMPLATE_EVENT]);
  });

  it.each([
    'account_update',
    'account_review_update',
    'phone_number_quality_update',
    'phone_number_name_update',
  ])('routes %s to the account processor', (field) => {
    expect(targets({ field, value: {} })).toEqual([LF_ACCOUNT_EVENT]);
  });

  /** An unrecognised field produces no jobs, which the caller records. */
  it('produces nothing for an unknown field', () => {
    expect(fanOut({ field: 'some_future_field', value: {} })).toEqual([]);
    expect(fanOut({})).toEqual([]);
  });
});

describe('fan-out over the recorded corpus', () => {
  const FIXTURE_DIR = join(process.cwd(), 'src/__tests__/fixtures/meta');

  const changes = readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json') && file !== 'manifest.json')
    .flatMap((file) => {
      const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as {
        body: MetaWebhookBody;
      };

      return (fixture.body.entry ?? []).flatMap((entry) =>
        (entry.changes ?? []).map((change) => ({ file, change })),
      );
    });

  /**
   * Every delivery Meta actually sent must reach a processor. A field that
   * silently produced no jobs would leave a `whatsappWebhookEvent` row marked
   * processed and nothing done — which reads exactly like success.
   */
  it('routes every recorded change to at least one processor', () => {
    const unrouted = changes
      .filter(({ change }) => fanOut(change).length === 0)
      .map(({ file, change }) => `${file}: ${change.field}`);

    expect(unrouted).toEqual([]);
  });

  it('found the corpus', () => {
    expect(changes.length).toBeGreaterThanOrEqual(33);
  });
});

describe('consent keyword matching', () => {
  const OPT_OUT = ['STOP', 'SAIR', 'PARAR', 'CANCELAR'];

  it.each(['STOP', 'stop', 'Sair', 'PARAR', ' cancelar '])('matches %p', (body) => {
    expect(matchesKeyword(body, OPT_OUT)).toBe(true);
  });

  /**
   * Substring matching here would unsubscribe an enthusiastic customer, which
   * is both a lost sale and an unrecoverable one.
   */
  it('does not match a keyword used inside a sentence', () => {
    expect(matchesKeyword('não vou parar de recomendar', OPT_OUT)).toBe(false);
    expect(matchesKeyword('stopped by the office today', OPT_OUT)).toBe(false);
  });

  it('matches a keyword as a standalone token in a short reply', () => {
    expect(matchesKeyword('STOP.', OPT_OUT)).toBe(true);
    expect(matchesKeyword('sair!', OPT_OUT)).toBe(true);
  });

  it('folds accents so SAIR matches "saír"', () => {
    expect(matchesKeyword('saír', OPT_OUT)).toBe(true);
  });

  it('handles an absent or empty body', () => {
    expect(matchesKeyword(null, OPT_OUT)).toBe(false);
    expect(matchesKeyword('   ', OPT_OUT)).toBe(false);
  });
});

describe('window kind', () => {
  /**
   * The 72h free window is tied to the referral conversation. Carrying it
   * forward would let us message a contact for free long after the ad expired.
   */
  it('grants a free-entry-point window only to a referral message', () => {
    expect(windowForMessage(true)).toBe(WINDOW_KIND.FREE_ENTRY_POINT);
    expect(windowForMessage(false)).toBe(WINDOW_KIND.STANDARD);
  });
});

describe('status orphans', () => {
  const at = (iso: string) => new Date(iso);
  const epoch = (iso: string) => String(Math.floor(at(iso).getTime() / 1000));

  /** The status webhook can legitimately beat our own POST response. */
  it('treats a fresh orphan as worth retrying', () => {
    expect(
      isRecentEnoughToRetry({ timestamp: epoch('2026-08-15T12:00:00Z') }, at('2026-08-15T12:01:00Z')),
    ).toBe(true);
  });

  it('gives up past the grace window', () => {
    expect(
      isRecentEnoughToRetry({ timestamp: epoch('2026-08-15T12:00:00Z') }, at('2026-08-15T12:06:00Z')),
    ).toBe(false);
    expect(ORPHAN_GRACE_MS).toBe(300_000);
  });

  it('retries when the timestamp is unusable rather than discarding the status', () => {
    expect(isRecentEnoughToRetry({}, at('2026-08-15T12:00:00Z'))).toBe(true);
    expect(isRecentEnoughToRetry({ timestamp: 'nonsense' }, at('2026-08-15T12:00:00Z'))).toBe(true);
  });
});

describe('template components update', () => {
  /** Meta sends the changed parts under its own field names, not a component array. */
  it('reconstructs a component array from the flat update shape', () => {
    expect(
      componentsFromUpdate({
        message_template_title: 'message header',
        message_template_element: 'Olá {{1}}',
        message_template_footer: 'message footer',
        message_template_buttons: [
          {
            message_template_button_type: 'URL',
            message_template_button_text: 'button text',
            message_template_button_url: 'https://example.com',
          },
        ],
      }),
    ).toEqual([
      { type: 'HEADER', format: 'TEXT', text: 'message header' },
      { type: 'BODY', text: 'Olá {{1}}' },
      { type: 'FOOTER', text: 'message footer' },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'button text',
            url: 'https://example.com',
            phone_number: undefined,
          },
        ],
      },
    ]);
  });

  it('returns null when nothing recognisable changed', () => {
    expect(componentsFromUpdate({ message_template_id: 1 })).toBeNull();
  });
});

describe('media worker', () => {
  /** Never the sender-supplied filename: the classic path-traversal vector. */
  it('derives a safe filename from the wamid and mime type', () => {
    expect(storageFilename('wamid.ABC123', 'audio/ogg; codecs=opus')).toBe('wamid.ABC123.ogg');
    expect(storageFilename('wamid.X', 'image/jpeg')).toBe('wamid.X.jpg');
    expect(storageFilename('../../etc/passwd', 'application/pdf')).toBe('....etcpasswd.pdf');
  });

  it('falls back to the mime subtype for an unmapped type', () => {
    expect(storageFilename('wamid.X', 'application/vnd.custom')).toBe('wamid.X.vndcustom');
    expect(storageFilename('wamid.X', null)).toBe('wamid.X.bin');
  });

  it('uses the inline URL only while it is comfortably valid', () => {
    const now = new Date('2026-08-15T12:00:00Z');
    const at = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

    expect(
      isInlineUrlUsable({ inlineUrl: 'https://x', inlineUrlExpiresAt: at(60_000) }, now),
    ).toBe(true);

    // A URL expiring mid-transfer costs a full retry cycle, so the margin is
    // not zero.
    expect(
      isInlineUrlUsable({ inlineUrl: 'https://x', inlineUrlExpiresAt: at(5_000) }, now),
    ).toBe(false);
    expect(
      isInlineUrlUsable({ inlineUrl: 'https://x', inlineUrlExpiresAt: at(-1) }, now),
    ).toBe(false);
  });

  it('refuses an inline URL with no or unparseable expiry', () => {
    expect(isInlineUrlUsable({ inlineUrl: 'https://x' })).toBe(false);
    expect(isInlineUrlUsable({ inlineUrl: 'https://x', inlineUrlExpiresAt: 'soon' })).toBe(false);
    expect(isInlineUrlUsable({})).toBe(false);
  });

  it('backs off 2s, 8s, 32s, 128s', () => {
    expect([0, 1, 2, 3].map(retryDelayMs)).toEqual([2_000, 8_000, 32_000, 128_000]);
  });
});
