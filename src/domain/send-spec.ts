import type { OutboundMediaKind } from './media-limits';

/**
 * What an outbound message *is*, stored on `whatsappMessage.payload`.
 *
 * The wire payload is deliberately not stored. It is rebuilt at send time from
 * this, so a message queued at 09:00 and sent at 09:03 picks up a media id
 * resolved in between and a template whose spec was re-synced meanwhile.
 *
 * It lives in the domain rather than beside the sender because four different
 * callers produce one — the composer route, the consent keyword handler, the
 * workflow action and the campaign runner — and a shared type owned by one of
 * them would make the other three import from a logic function.
 */

export type SendSpec =
  | { kind: 'text'; body: string; previewUrl?: boolean; contextWamid?: string | null }
  | {
      kind: 'media';
      mediaKind: OutboundMediaKind;
      /** The file *record*; not enough to fetch bytes with, which is why the next two exist. */
      fileId?: string | null;
      fileUrl?: string | null;
      filePath?: string | null;
      filename?: string | null;
      caption?: string | null;
      /**
       * A microphone recording rather than an attached audio file.
       *
       * Meta does not infer it — an `.ogg` recorded in the composer and an
       * `.ogg` somebody attached are byte-identical to the API — so the flag
       * has to travel with the intention. Without it the customer receives a
       * voice note as a file attachment, and our own transcript shows the
       * generic audio card for a message that was plainly a voice message.
       */
      voice?: boolean;
      contextWamid?: string | null;
    }
  | {
      kind: 'template';
      templateId: string;
      /**
       * A template sent *as a reply* to a specific message.
       *
       * `buildTemplatePayload` has accepted this since it was written — the
       * envelope helper carries `context` for every type — but nothing ever
       * passed it, so choosing Reply and then sending a template silently
       * dropped the quote. With the window closed a template is the *only*
       * send available, which is precisely when a rep most needs to say which
       * message they are answering.
       */
      contextWamid?: string | null;
    }
  | {
      kind: 'interactive';
      interactive: Record<string, unknown>;
      contextWamid?: string | null;
    }
  | { kind: 'reaction'; targetWamid: string; emoji: string }
  | {
      kind: 'location';
      latitude: number;
      longitude: number;
      name?: string | null;
      address?: string | null;
      contextWamid?: string | null;
    }
  | { kind: 'contacts'; contacts: unknown[]; contextWamid?: string | null };

export type SendSpecKind = SendSpec['kind'];
