import type { MetaTemplateComponent } from '../../domain/template-spec';

/**
 * The provider seam (AR-18, D-14, appendix A §9).
 *
 * Everything the app knows about Meta's HTTP surface is stated here and
 * implemented once. The point is not portability for its own sake — it is that
 * a single interface makes "which code can talk to Meta?" answerable by reading
 * one file, and makes a fake provider in tests a type-checked substitute rather
 * than a hopeful mock.
 */

export type SendContext = { message_id: string };

export type MediaSendPayload = {
  id: string;
  caption?: string;
  filename?: string;
};

export type TemplateParameter =
  | { type: 'text'; text: string; parameter_name?: string }
  | { type: 'currency'; currency: unknown }
  | { type: 'date_time'; date_time: unknown }
  | { type: 'image'; image: { id: string } }
  | { type: 'video'; video: { id: string } }
  | { type: 'document'; document: { id: string; filename?: string } };

export type TemplateComponentPayload = {
  type: 'header' | 'body' | 'button';
  sub_type?: string;
  index?: string;
  parameters: TemplateParameter[];
};

export type SendPayload = {
  messaging_product: 'whatsapp';
  recipient_type?: 'individual';
  to: string;
  type: string;
  context?: SendContext;
  text?: { body: string; preview_url?: boolean };
  image?: MediaSendPayload;
  video?: MediaSendPayload;
  audio?: MediaSendPayload;
  document?: MediaSendPayload;
  sticker?: MediaSendPayload;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: unknown[];
  reaction?: { message_id: string; emoji: string };
  interactive?: unknown;
  template?: {
    name: string;
    language: { code: string };
    components?: TemplateComponentPayload[];
  };
};

export type SendResult = {
  wamid: string;
  /** Meta echoes the resolved `wa_id`, which can differ from what we sent (FR-CID-2). */
  resolvedWaId: string | null;
  raw: unknown;
};

export type MetaMediaHandle = {
  url: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
};

export type MetaTemplate = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  qualityScore: string | null;
  components: MetaTemplateComponent[];
};

export type MetaTemplateDefinition = {
  name: string;
  language: string;
  category: string;
  components: MetaTemplateComponent[];
};

export type MetaPhoneNumber = {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  throughputLevel: string | null;
};

export type WhatsAppProvider = {
  readonly name: string;

  sendMessage(input: {
    phoneNumberId: string;
    payload: SendPayload;
  }): Promise<SendResult>;

  markAsRead(input: { phoneNumberId: string; wamid: string }): Promise<void>;

  uploadMedia(input: {
    phoneNumberId: string;
    buffer: Buffer;
    mimeType: string;
    filename: string;
  }): Promise<{ mediaId: string }>;

  fetchMediaUrl(mediaId: string): Promise<MetaMediaHandle>;

  downloadMedia(url: string): Promise<{ buffer: Buffer; mimeType: string }>;

  listTemplates(
    wabaId: string,
    cursor?: string,
  ): Promise<{ templates: MetaTemplate[]; nextCursor?: string }>;

  createTemplate(
    wabaId: string,
    definition: MetaTemplateDefinition,
  ): Promise<{ id: string; status: string }>;

  getPhoneNumber(phoneNumberId: string): Promise<MetaPhoneNumber>;

  subscribeApp(wabaId: string): Promise<void>;
};
