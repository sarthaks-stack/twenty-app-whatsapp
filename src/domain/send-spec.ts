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
      contextWamid?: string | null;
    }
  | { kind: 'template'; templateId: string }
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
