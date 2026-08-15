import type { MetaChange, MetaMessage } from './types';

/**
 * Classifies a single `entry[].changes[]` element.
 *
 * Two consumers, one implementation:
 *  - the capture harness, to name fixture files and track coverage;
 *  - `wa-webhook-ingest`, to decide which processors to enqueue (specs/00 D-2).
 *
 * A single `messages` change can contain messages *and* statuses *and* errors
 * at once, which is why `kinds` is a set rather than a single value — that fact
 * is the whole reason the fan-out lives inside the workspace.
 */

export type WebhookChangeKind =
  | 'inbound_message'
  | 'status'
  | 'account_error'
  | 'template_status'
  | 'template_quality'
  | 'template_components'
  | 'account_update'
  | 'phone_quality'
  | 'account_review'
  | 'phone_name'
  | 'unknown';

export type ChangeClassification = {
  field: string;
  kinds: WebhookChangeKind[];
  messageCount: number;
  statusCount: number;
  /** Stable, filesystem-safe descriptors — one per item in the change. */
  slugs: string[];
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const inboundMessageSlug = (message: MetaMessage): string => {
  const type = message.type ?? 'unknown';

  const base = ((): string => {
    if (type === 'reaction') {
      const emoji = message.reaction?.emoji ?? '';
      return emoji.length === 0 ? 'reaction-remove' : 'reaction-add';
    }

    if (type === 'audio' && message.audio?.voice === true) {
      return 'audio-voice';
    }

    if (type === 'sticker' && message.sticker?.animated === true) {
      return 'sticker-animated';
    }

    if (type === 'interactive') {
      return `interactive-${slugify(message.interactive?.type ?? 'unknown')}`;
    }

    return slugify(type);
  })();

  const suffixes: string[] = [];

  if (message.referral !== undefined) suffixes.push('referral');

  /**
   * `context` distinguishes a quoted reply only for types that can also arrive
   * without one. For a reaction, an interactive reply or a template quick-reply
   * button, the context is *intrinsic* — it points at the message being reacted
   * to or replied to, and is always present. Appending `reply` there produced
   * `inbound-interactive-button-reply-reply`, which matched no required fixture
   * and silently withheld coverage credit.
   *
   * Missed by the unit tests because they built interactive messages without a
   * `context`, which real deliveries never do.
   */
  const CONTEXT_IS_INTRINSIC = new Set(['reaction', 'interactive', 'button']);

  if (message.context?.id !== undefined && !CONTEXT_IS_INTRINSIC.has(type)) {
    suffixes.push('reply');
  }
  if (message.errors !== undefined && message.errors.length > 0) {
    suffixes.push('error');
  }

  return ['inbound', base, ...suffixes].join('-');
};

export const classifyChange = (change: MetaChange): ChangeClassification => {
  const field = change.field ?? 'unknown';
  const value = change.value ?? {};
  const kinds: WebhookChangeKind[] = [];
  const slugs: string[] = [];

  const messages = value.messages ?? [];
  const statuses = value.statuses ?? [];

  if (messages.length > 0) {
    kinds.push('inbound_message');
    for (const message of messages) slugs.push(inboundMessageSlug(message));
  }

  if (statuses.length > 0) {
    kinds.push('status');
    for (const status of statuses) {
      const name = slugify(status.status ?? 'unknown');
      const code = status.errors?.[0]?.code;
      slugs.push(
        code === undefined ? `status-${name}` : `status-${name}-${code}`,
      );
    }
  }

  if (
    messages.length === 0 &&
    statuses.length === 0 &&
    (value.errors ?? []).length > 0
  ) {
    kinds.push('account_error');
    slugs.push(`account-error-${value.errors?.[0]?.code ?? 'unknown'}`);
  }

  switch (field) {
    case 'message_template_status_update':
      kinds.push('template_status');
      slugs.push(`template-status-${slugify(value.event ?? 'unknown')}`);
      break;
    case 'message_template_quality_update':
      kinds.push('template_quality');
      slugs.push(
        `template-quality-${slugify(value.new_quality_score ?? 'unknown')}`,
      );
      break;
    case 'message_template_components_update':
      kinds.push('template_components');
      slugs.push('template-components-update');
      break;
    case 'phone_number_quality_update':
      kinds.push('phone_quality');
      slugs.push(`phone-quality-${slugify(value.event ?? 'unknown')}`);
      break;
    case 'account_update':
      kinds.push('account_update');
      slugs.push(`account-update-${slugify(value.event ?? 'unknown')}`);
      break;
    case 'account_review_update':
      kinds.push('account_review');
      slugs.push(`account-review-${slugify(value.decision ?? 'unknown')}`);
      break;
    case 'phone_number_name_update':
      kinds.push('phone_name');
      slugs.push(`phone-name-${slugify(value.decision ?? 'unknown')}`);
      break;
    default:
      break;
  }

  if (kinds.length === 0) {
    kinds.push('unknown');
    slugs.push(`unknown-${slugify(field)}`);
  }

  return {
    field,
    kinds,
    messageCount: messages.length,
    statusCount: statuses.length,
    slugs,
  };
};

/** The `phone_number_id` (preferred) or WABA id used to route to a workspace (specs/00 D-3). */
export const routingKeysForChange = (
  entryId: string | undefined,
  change: MetaChange,
): { phoneNumberId?: string; wabaId?: string } => ({
  phoneNumberId: change.value?.metadata?.phone_number_id,
  wabaId: entryId,
});
