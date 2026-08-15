import { describe, expect, it } from 'vitest';

import { MESSAGE_TYPE } from './constants';
import {
  effectiveMediaKind,
  normaliseInboundMessage,
  parseInlineUrlExpiry,
  truncatePreview,
} from './inbound-normalise';
import type { MetaMessage } from './webhook/types';

const message = (overrides: Partial<MetaMessage>): MetaMessage => ({
  from: '244917164819',
  id: 'wamid.TEST',
  timestamp: '1786809498',
  ...overrides,
});

describe('text', () => {
  it('stores the body and leaves the payload null', () => {
    const result = normaliseInboundMessage(message({ type: 'text', text: { body: 'Olá!' } }));

    expect(result.messageType).toBe(MESSAGE_TYPE.TEXT);
    expect(result.body).toBe('Olá!');
    expect(result.payload).toBeNull();
    expect(result.isMedia).toBe(false);
    expect(result.preview).toBe('Olá!');
  });

  it('parses the timestamp into a Date', () => {
    expect(normaliseInboundMessage(message({ type: 'text' })).waTimestamp).toEqual(
      new Date(1786809498 * 1000),
    );
  });

  it('records a quoted reply', () => {
    const result = normaliseInboundMessage(
      message({ type: 'text', text: { body: 'sim' }, context: { id: 'wamid.PARENT' } }),
    );

    expect(result.contextWamid).toBe('wamid.PARENT');
  });
});

describe('media', () => {
  const audio = message({
    type: 'audio',
    audio: {
      mime_type: 'audio/ogg; codecs=opus',
      sha256: '63juxiuEcBW/0zL4fohL7BAe1wPQAZrR55NInYcG8qA=',
      id: '987180650994148',
      url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=987180650994148&ext=1786809799&hash=abc',
      voice: true,
    },
  });

  it('extracts the media metadata a worker needs', () => {
    const result = normaliseInboundMessage(audio);

    expect(result.messageType).toBe(MESSAGE_TYPE.AUDIO);
    expect(result.isMedia).toBe(true);
    expect(result.mediaMeta).toMatchObject({
      mediaId: '987180650994148',
      mimeType: 'audio/ogg; codecs=opus',
      voice: true,
      downloadAttempts: 0,
    });
  });

  it('captures the inlined URL and its expiry', () => {
    const result = normaliseInboundMessage(audio);

    expect(result.mediaMeta?.inlineUrl).toContain('lookaside.fbsbx.com');
    expect(result.mediaMeta?.inlineUrlExpiresAt).toEqual(new Date(1786809799 * 1000));
  });

  it('previews a voice note distinctly from other audio', () => {
    expect(normaliseInboundMessage(audio).preview).toBe('🎤 Mensagem de voz');
    expect(
      normaliseInboundMessage(
        message({ type: 'audio', audio: { id: '1', mime_type: 'audio/mpeg' } }),
      ).preview,
    ).toBe('🎵 Áudio');
  });

  it('uses the caption as the body when there is one', () => {
    const result = normaliseInboundMessage(
      message({ type: 'image', image: { id: '1', mime_type: 'image/jpeg', caption: 'Proposta' } }),
    );

    expect(result.body).toBe('Proposta');
    expect(result.preview).toBe('📷 Imagem · Proposta');
  });

  it('falls back to the filename for a document with no caption', () => {
    const result = normaliseInboundMessage(
      message({
        type: 'document',
        document: { id: '1', mime_type: 'application/pdf', filename: 'contrato.pdf' },
      }),
    );

    expect(result.body).toBe('contrato.pdf');
    expect(result.mediaMeta?.filename).toBe('contrato.pdf');
    expect(result.preview).toBe('📄 Documento · contrato.pdf');
  });

  /**
   * Observed on the real test device 2026-08-15: an audio file chosen from the
   * document picker arrives as `type: document`. The stored type stays faithful
   * to Meta; every renderer keys off `effectiveMediaKind` instead, or a
   * customer who plainly sent audio gets a download link (specs/03 §4.1).
   */
  it('reports an audio/* document as audio without rewriting the stored type', () => {
    const result = normaliseInboundMessage(
      message({
        type: 'document',
        document: { id: '1', mime_type: 'audio/mpeg', filename: 'nota.mp3' },
      }),
    );

    expect(result.messageType).toBe(MESSAGE_TYPE.DOCUMENT);
    expect(effectiveMediaKind(result.mediaMeta, result.messageType)).toBe('audio');
    expect(result.preview).toBe('🎵 Áudio · nota.mp3');
  });

  it('does the same for video and image documents', () => {
    for (const [mime, kind] of [
      ['video/mp4', 'video'],
      ['image/png', 'image'],
      ['application/pdf', 'file'],
    ] as const) {
      const result = normaliseInboundMessage(
        message({ type: 'document', document: { id: '1', mime_type: mime } }),
      );

      expect(effectiveMediaKind(result.mediaMeta, result.messageType)).toBe(kind);
    }
  });

  it('keeps a sticker a sticker whatever its mime type', () => {
    const result = normaliseInboundMessage(
      message({ type: 'sticker', sticker: { id: '1', mime_type: 'image/webp', animated: true } }),
    );

    expect(result.messageType).toBe(MESSAGE_TYPE.STICKER);
    expect(effectiveMediaKind(result.mediaMeta, result.messageType)).toBe('sticker');
    expect(result.mediaMeta?.animated).toBe(true);
  });
});

describe('parseInlineUrlExpiry', () => {
  it('reads decimal epoch seconds from ext', () => {
    expect(parseInlineUrlExpiry('https://x/?mid=1&ext=1786809799&hash=z')).toEqual(
      new Date(1786809799 * 1000),
    );
  });

  it('returns null when there is no ext', () => {
    expect(parseInlineUrlExpiry('https://x/?mid=1')).toBeNull();
    expect(parseInlineUrlExpiry(undefined)).toBeNull();
  });

  /**
   * An over-long expiry is the dangerous direction: it would make the worker
   * trust a dead URL and skip the `GET /{media_id}` fallback.
   */
  it('rejects a millisecond value rather than dating it to the year 58000', () => {
    expect(parseInlineUrlExpiry('https://x/?ext=1786809799000')).toBeNull();
  });
});

describe('location', () => {
  it('prefers the name, then the address, then coordinates', () => {
    expect(
      normaliseInboundMessage(
        message({ type: 'location', location: { latitude: -8.8, longitude: 13.2, name: 'Escritório' } }),
      ).body,
    ).toBe('Escritório');

    expect(
      normaliseInboundMessage(
        message({ type: 'location', location: { latitude: -8.8, longitude: 13.2, address: 'Rua X' } }),
      ).body,
    ).toBe('Rua X');

    expect(
      normaliseInboundMessage(
        message({ type: 'location', location: { latitude: -8.8, longitude: 13.2 } }),
      ).body,
    ).toBe('-8.8, 13.2');
  });
});

describe('contacts', () => {
  it('uses the first contact card name', () => {
    const result = normaliseInboundMessage(
      message({
        type: 'contacts',
        contacts: [{ name: { formatted_name: 'Ana Silva', first_name: 'Ana' } }],
      }),
    );

    expect(result.messageType).toBe(MESSAGE_TYPE.CONTACTS);
    expect(result.body).toBe('Ana Silva');
    expect(result.preview).toBe('👤 Contacto · Ana Silva');
    // Wrapped, not bare: Twenty types RAW_JSON as an object.
    expect(result.payload).toEqual({
      contacts: [{ name: { formatted_name: 'Ana Silva', first_name: 'Ana' } }],
    });
  });

  it('survives a card with no name', () => {
    const result = normaliseInboundMessage(message({ type: 'contacts', contacts: [{}] }));

    expect(result.body).toBeNull();
    expect(result.preview).toBe('👤 Contacto');
  });
});

describe('reactions', () => {
  it('stores the emoji and the target', () => {
    const result = normaliseInboundMessage(
      message({ type: 'reaction', reaction: { emoji: '👍', message_id: 'wamid.TARGET' } }),
    );

    expect(result.messageType).toBe(MESSAGE_TYPE.REACTION);
    expect(result.body).toBe('👍');
    expect(result.reactionTargetWamid).toBe('wamid.TARGET');
  });

  /** The same webhook shape carries add and remove; an empty emoji is remove. */
  it('represents a removal as an empty emoji, not a missing field', () => {
    const result = normaliseInboundMessage(
      message({ type: 'reaction', reaction: { emoji: '', message_id: 'wamid.TARGET' } }),
    );

    expect(result.body).toBe('');
    expect(result.reactionTargetWamid).toBe('wamid.TARGET');
  });
});

describe('interactive', () => {
  it('flattens a button reply', () => {
    const result = normaliseInboundMessage(
      message({
        type: 'interactive',
        context: { id: 'wamid.PARENT' },
        interactive: { type: 'button_reply', button_reply: { id: 'sim', title: 'Sim, quero' } },
      }),
    );

    expect(result.messageType).toBe(MESSAGE_TYPE.BUTTON_REPLY);
    expect(result.body).toBe('Sim, quero');
    expect(result.payload).toEqual({ id: 'sim', title: 'Sim, quero' });
  });

  it('flattens a list reply and keeps the description', () => {
    const result = normaliseInboundMessage(
      message({
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'opt-2', title: 'Plano Pro', description: '10 utilizadores' },
        },
      }),
    );

    expect(result.messageType).toBe(MESSAGE_TYPE.LIST_REPLY);
    expect(result.body).toBe('Plano Pro');
    expect(result.payload).toMatchObject({ description: '10 utilizadores' });
  });

  it('keeps a Flow reply readable before the UI can render it', () => {
    const result = normaliseInboundMessage(
      message({
        type: 'interactive',
        interactive: { type: 'nfm_reply', nfm_reply: { body: 'Formulário enviado' } },
      }),
    );

    expect(result.messageType).toBe(MESSAGE_TYPE.INTERACTIVE);
    expect(result.body).toBe('Formulário enviado');
    expect(result.payload).toMatchObject({ type: 'nfm_reply' });
  });
});

describe('template quick reply', () => {
  it('stores a top-level button tap as a button reply', () => {
    const result = normaliseInboundMessage(
      message({ type: 'button', button: { payload: 'PARAR', text: 'Parar' } }),
    );

    expect(result.messageType).toBe(MESSAGE_TYPE.BUTTON_REPLY);
    expect(result.body).toBe('Parar');
    expect(result.payload).toEqual({ payload: 'PARAR', text: 'Parar' });
  });
});

describe('unsupported and errored', () => {
  /** FR-IN-1: stored with a placeholder rather than dropped. */
  it('keeps the whole raw message for an unknown type', () => {
    const raw = message({ type: 'order', order: { catalog_id: 'x' } });
    const result = normaliseInboundMessage(raw);

    expect(result.messageType).toBe(MESSAGE_TYPE.UNSUPPORTED);
    expect(result.body).toBe('Tipo de mensagem não suportado: order');
    expect(result.payload).toBe(raw);
  });

  it('treats an undecryptable media message as unsupported with the error attached', () => {
    const result = normaliseInboundMessage(
      message({
        type: 'image',
        image: { id: '1' },
        errors: [{ code: 131052, title: 'Media download error' }],
      }),
    );

    expect(result.messageType).toBe(MESSAGE_TYPE.UNSUPPORTED);
    expect(result.errorCode).toBe('131052');
    expect(result.errorDetail).toBe('Media download error');
    expect(result.isMedia).toBe(false);
  });

  it('handles a message with no type at all', () => {
    expect(normaliseInboundMessage({ id: 'wamid.X' }).messageType).toBe(MESSAGE_TYPE.UNSUPPORTED);
  });
});

describe('truncatePreview', () => {
  it('collapses whitespace and caps at 120 characters', () => {
    expect(truncatePreview('Olá\n\n  mundo')).toBe('Olá mundo');

    const long = truncatePreview('a'.repeat(200));
    expect(long).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('payload shape', () => {
  /**
   * Twenty types every RAW_JSON column as `Record<string, unknown>`, so a bare
   * array would be rejected at write time — after the message had already been
   * accepted from Meta.
   */
  it('is never a bare array', () => {
    const cases: MetaMessage[] = [
      message({ type: 'text', text: { body: 'x' } }),
      message({ type: 'image', image: { id: '1' } }),
      message({ type: 'contacts', contacts: [{}] }),
      message({ type: 'location', location: { latitude: 1, longitude: 2 } }),
      message({ type: 'reaction', reaction: { emoji: '👍', message_id: 'w' } }),
      message({ type: 'interactive', interactive: { type: 'nfm_reply' } }),
      message({ type: 'button', button: { text: 'x' } }),
      message({ type: 'system', system: { body: 'x' } }),
      message({ type: 'order' }),
    ];

    for (const input of cases) {
      const { payload } = normaliseInboundMessage(input);

      expect(Array.isArray(payload), input.type).toBe(false);
      expect(payload === null || typeof payload === 'object', input.type).toBe(true);
    }
  });
});
