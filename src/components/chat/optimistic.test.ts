import { describe, expect, it } from 'vitest';

import { projectInteractive } from '../../domain/feed/content';
import { mergeMessages } from '../common/merge';
import {
  optimisticContacts,
  optimisticInteractive,
  optimisticLocation,
  optimisticMedia,
  optimisticTemplate,
  optimisticText,
} from './optimistic';

const BASE = { threadId: 't1', clientToken: 'tok-1' };

/**
 * The rule every one of these has to hold: the optimistic bubble and the
 * delivered one go through the same renderer, so they cannot look different.
 * A `content` that did not match its `type` would draw a document card over a
 * location for as long as the send took.
 */
describe('the optimistic factory', () => {
  it('pairs each send with the message type its renderer keys off', () => {
    expect(optimisticText(BASE, 'Olá')).toMatchObject({
      type: 'TEXT',
      content: { kind: 'text', body: 'Olá' },
      status: 'QUEUED',
      direction: 'OUTBOUND',
    });

    expect(
      optimisticLocation(BASE, {
        latitude: -8.9126,
        longitude: 13.2334,
        name: 'Talatona',
        address: null,
      }),
    ).toMatchObject({
      type: 'LOCATION',
      content: { kind: 'location', name: 'Talatona', latitude: -8.9126 },
    });

    expect(
      optimisticContacts(BASE, [
        {
          formattedName: 'Abel Febere',
          firstName: 'Abel',
          lastName: null,
          organization: null,
          title: null,
          phones: [],
          emails: [],
        },
      ]),
    ).toMatchObject({ type: 'CONTACTS', content: { kind: 'contacts' } });
  });

  it('routes a voice send to the voice card and an audio file to the other one', () => {
    const voice = optimisticMedia(BASE, {
      mediaKind: 'audio',
      url: 'https://host/f1',
      fileName: 'voice-8s.ogg',
      mimeType: 'audio/ogg',
      sizeBytes: 4_096,
      caption: null,
      isVoice: true,
    });

    expect(voice.content).toMatchObject({ kind: 'audio', isVoice: true });
    expect(voice.media).toMatchObject({ isVoice: true, url: 'https://host/f1' });

    const file = optimisticMedia(BASE, {
      mediaKind: 'audio',
      url: 'https://host/f2',
      fileName: 'faixa.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 4_096,
      caption: null,
    });

    expect(file.content).toMatchObject({ kind: 'audio', isVoice: false });
  });

  /**
   * The preview is the stored file's own URL — the same one the delivered
   * bubble renders — so the image does not visibly reload when the server row
   * arrives a moment later.
   */
  it('shows an image from the file already stored, not a placeholder', () => {
    expect(
      optimisticMedia(BASE, {
        mediaKind: 'image',
        url: 'https://host/photo.jpg',
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 51_200,
        caption: 'Aqui está',
      }),
    ).toMatchObject({
      type: 'IMAGE',
      content: { kind: 'image', caption: 'Aqui está' },
      media: { url: 'https://host/photo.jpg' },
    });
  });

  it('previews an interactive message exactly as the transcript will render it', () => {
    const interactive = projectInteractive({
      type: 'button',
      body: { text: 'Confirma?' },
      action: { buttons: [{ type: 'reply', reply: { id: 'b1', title: 'Sim' } }] },
    });

    expect(optimisticInteractive(BASE, interactive)).toMatchObject({
      type: 'INTERACTIVE',
      body: 'Confirma?',
      content: { kind: 'interactive', interactive: { kind: 'buttons' } },
    });
  });

  it('carries the template’s name so the bubble is tagged before it is sent', () => {
    expect(
      optimisticTemplate(
        { ...BASE, body: 'Olá Marcos' },
        { name: 'boas_vindas', language: 'pt_PT', category: 'UTILITY' },
      ),
    ).toMatchObject({
      type: 'TEMPLATE',
      templateName: 'boas_vindas',
      content: { kind: 'template', template: { name: 'boas_vindas', body: 'Olá Marcos' } },
    });
  });

  /**
   * Step 4 of the spec's reply flow: the optimistic bubble carries the quote
   * immediately, so the strip does not appear only once the send lands.
   */
  it('carries the reply strip and the contextWamid that produced it', () => {
    const quote = {
      wamid: 'wamid.X',
      direction: 'INBOUND' as const,
      senderLabel: 'Marcos',
      type: 'TEXT',
      preview: 'A morada é ali',
      thumbnailUrl: null,
    };

    const bubble = optimisticText({ ...BASE, quote }, 'Chego às 10:00');

    expect(bubble.quote).toEqual(quote);
    expect(bubble.contextWamid).toBe('wamid.X');
  });

  /**
   * The reconciliation contract, unchanged since the first release: the
   * server's row replaces the local one by `clientToken` rather than appearing
   * beside it, so a rep never sees their message twice.
   */
  it('is replaced by the server’s row rather than doubled', () => {
    const local = optimisticText(BASE, 'Olá');
    const server = { ...local, id: 'm1', status: 'ACCEPTED', wamid: 'wamid.Y' };

    const merged = mergeMessages([local], [server]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'm1', status: 'ACCEPTED' });
  });
});
