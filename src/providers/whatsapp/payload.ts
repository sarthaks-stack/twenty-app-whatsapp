import {
  PARAMETER_LIMITS,
  sanitiseParameter,
  type ResolvedParameters,
} from '../../domain/template-render';
import type { VariableSpec } from '../../domain/template-spec';
import type {
  SendPayload,
  TemplateComponentPayload,
  TemplateParameter,
} from './types';

/**
 * Meta send payloads (appendix A §2, specs/04 §6). Golden-file tested.
 *
 * Two invariants hold across every builder:
 *
 *  - **`to` is the thread's `waId`, never `dialablePhone`** (FR-CID-2). For
 *    Argentina and Mexico these differ, and using the dialable form produces
 *    *silent* non-delivery — Meta accepts the request and nothing arrives, so
 *    there is no error to notice.
 *  - **Media goes by `id`, never `link`** (AR-14). A link send hands Meta a URL
 *    that must be publicly reachable, which for CRM-hosted files means either a
 *    public bucket or a broken send.
 */

const envelope = (to: string, type: string, contextWamid?: string | null): SendPayload => ({
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to,
  type,
  ...(contextWamid === null || contextWamid === undefined
    ? {}
    : { context: { message_id: contextWamid } }),
});

export type BaseSend = { to: string; contextWamid?: string | null };

export const buildTextPayload = ({
  to,
  body,
  previewUrl = true,
  contextWamid,
}: BaseSend & { body: string; previewUrl?: boolean }): SendPayload => ({
  ...envelope(to, 'text', contextWamid),
  text: { body, preview_url: previewUrl },
});

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export const buildMediaPayload = ({
  to,
  kind,
  mediaId,
  caption,
  filename,
  voice = false,
  contextWamid,
}: BaseSend & {
  kind: MediaKind;
  mediaId: string;
  caption?: string | null;
  filename?: string | null;
  /** Audio only: renders as a voice note on the recipient's device. */
  voice?: boolean;
}): SendPayload => {
  // Stickers and audio carry no caption; Meta rejects the field outright.
  const acceptsCaption = kind === 'image' || kind === 'video' || kind === 'document';

  return {
    ...envelope(to, kind, contextWamid),
    [kind]: {
      id: mediaId,
      ...(acceptsCaption && caption !== null && caption !== undefined && caption.length > 0
        ? { caption }
        : {}),
      ...(kind === 'document' && filename !== null && filename !== undefined
        ? { filename }
        : {}),
      /**
       * Only ever set, never sent as `false`. Meta treats the field's
       * *presence* as the signal on some Graph versions, and a `voice: false`
       * on an ordinary audio attachment is a field with no defined meaning.
       */
      ...(kind === 'audio' && voice ? { voice: true } : {}),
    },
  };
};

export const buildLocationPayload = ({
  to,
  latitude,
  longitude,
  name,
  address,
  contextWamid,
}: BaseSend & {
  latitude: number;
  longitude: number;
  name?: string | null;
  address?: string | null;
}): SendPayload => ({
  ...envelope(to, 'location', contextWamid),
  location: {
    latitude,
    longitude,
    ...(name === null || name === undefined ? {} : { name }),
    ...(address === null || address === undefined ? {} : { address }),
  },
});

export const buildContactsPayload = ({
  to,
  contacts,
  contextWamid,
}: BaseSend & { contacts: unknown[] }): SendPayload => ({
  ...envelope(to, 'contacts', contextWamid),
  contacts,
});

/**
 * An empty emoji removes the reaction — the same call, not a delete endpoint.
 * `context` is never set: a reaction already names its target in `message_id`,
 * and adding a context makes Meta reject the payload.
 */
export const buildReactionPayload = ({
  to,
  targetWamid,
  emoji,
}: {
  to: string;
  targetWamid: string;
  emoji: string;
}): SendPayload => ({
  ...envelope(to, 'reaction'),
  reaction: { message_id: targetWamid, emoji },
});

export type ReplyButton = { id: string; title: string };

export const MAX_REPLY_BUTTONS = 3;

export const buildInteractiveButtonsPayload = ({
  to,
  body,
  buttons,
  header,
  footer,
  contextWamid,
}: BaseSend & {
  body: string;
  buttons: ReplyButton[];
  header?: string | null;
  footer?: string | null;
}): SendPayload => {
  if (buttons.length === 0 || buttons.length > MAX_REPLY_BUTTONS) {
    throw new RangeError(
      `Interactive replies take 1–${MAX_REPLY_BUTTONS} buttons, received ${buttons.length}`,
    );
  }

  return {
    ...envelope(to, 'interactive', contextWamid),
    interactive: {
      type: 'button',
      ...(header === null || header === undefined ? {} : { header: { type: 'text', text: header } }),
      body: { text: body },
      ...(footer === null || footer === undefined ? {} : { footer: { text: footer } }),
      action: {
        buttons: buttons.map((button) => ({
          type: 'reply',
          reply: { id: button.id, title: button.title },
        })),
      },
    },
  };
};

export type ListSection = {
  title: string;
  rows: { id: string; title: string; description?: string }[];
};

export const buildInteractiveListPayload = ({
  to,
  body,
  buttonText,
  sections,
  header,
  footer,
  contextWamid,
}: BaseSend & {
  body: string;
  buttonText: string;
  sections: ListSection[];
  header?: string | null;
  footer?: string | null;
}): SendPayload => ({
  ...envelope(to, 'interactive', contextWamid),
  interactive: {
    type: 'list',
    ...(header === null || header === undefined ? {} : { header: { type: 'text', text: header } }),
    body: { text: body },
    ...(footer === null || footer === undefined ? {} : { footer: { text: footer } }),
    action: { button: buttonText, sections },
  },
});

const textParameter = (
  value: string,
  name: string | undefined,
  maxLength: number,
): TemplateParameter => ({
  type: 'text',
  text: sanitiseParameter(value, { maxLength }),
  ...(name === undefined ? {} : { parameter_name: name }),
});

/**
 * Template components (appendix A §2).
 *
 * The parameter *array* is what Meta validates, not the placeholder numbers, so
 * order must follow `spec.body.indices` exactly — the same contract
 * `ResolvedParameters.body` was built against. Getting this wrong yields 132000
 * for every recipient of a campaign, which is why both ends read the spec
 * rather than assuming `{{1}}` is first.
 *
 * `parameter_name` appears only when the template genuinely uses named
 * parameters, detected at sync time (`variableSpec.namedParameters`) rather
 * than guessed.
 */
export const buildTemplateComponents = (
  spec: VariableSpec,
  parameters: ResolvedParameters,
): TemplateComponentPayload[] => {
  const components: TemplateComponentPayload[] = [];

  const header = parameters.header;
  if (spec.header !== null && header !== undefined) {
    if (header.kind === 'media') {
      const format = spec.header.format;

      /**
       * A declared header that cannot produce a parameter throws here rather
       * than being dropped from the payload.
       *
       * Silently omitting it built a request Meta answers with 132000 —
       * "parameter count mismatch" — for every recipient of the campaign, an
       * error that names the symptom and hides the cause. The media send path
       * has refused an absent media id from the start; this is the same rule
       * for a template's header (D-42).
       */
      const mediaParameter = ((): TemplateParameter | null => {
        if (header.mediaId === null) return null;
        if (format === 'IMAGE') return { type: 'image', image: { id: header.mediaId } };
        if (format === 'VIDEO') return { type: 'video', video: { id: header.mediaId } };
        if (format === 'DOCUMENT') return { type: 'document', document: { id: header.mediaId } };

        return null;
      })();

      if (mediaParameter === null) {
        throw new RangeError(
          header.mediaId === null
            ? `The template's ${format.toLowerCase()} header has no resolved media id`
            : `A ${format} header cannot be filled from the CRM`,
        );
      }

      components.push({ type: 'header', parameters: [mediaParameter] });
    } else if (header.kind === 'text' && header.values.length > 0) {
      components.push({
        type: 'header',
        parameters: header.values.map((value, position) =>
          textParameter(
            value,
            spec.namedParameters ? spec.header?.names[position] : undefined,
            PARAMETER_LIMITS.HEADER,
          ),
        ),
      });
    }
  }

  if (parameters.body.length > 0) {
    components.push({
      type: 'body',
      parameters: parameters.body.map((value, position) =>
        textParameter(
          value,
          spec.namedParameters ? spec.body.names[position] : undefined,
          PARAMETER_LIMITS.BODY,
        ),
      ),
    });
  }

  for (const button of parameters.buttons) {
    components.push({
      type: 'button',
      sub_type: button.subType,
      // Meta wants the index as a *string*; a number is rejected.
      index: String(button.index),
      parameters: [
        {
          type: 'text',
          text: sanitiseParameter(button.value, {
            maxLength: PARAMETER_LIMITS.BUTTON_URL,
            ellipsis: false,
          }),
        },
      ],
    });
  }

  return components;
};

export const buildTemplatePayload = ({
  to,
  name,
  languageCode,
  spec,
  parameters,
  contextWamid,
}: BaseSend & {
  name: string;
  languageCode: string;
  spec: VariableSpec;
  parameters: ResolvedParameters;
}): SendPayload => {
  const components = buildTemplateComponents(spec, parameters);

  return {
    ...envelope(to, 'template', contextWamid),
    template: {
      name,
      language: { code: languageCode },
      ...(components.length === 0 ? {} : { components }),
    },
  };
};
