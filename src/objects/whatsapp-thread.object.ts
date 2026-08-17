import { defineObject, FieldType } from 'twenty-sdk/define';

import { fieldId, THREAD_PROFILE_NAME } from 'src/constants/field-identifiers';
import { OBJ_THREAD } from 'src/constants/universal-identifiers';

const f = (name: string) => fieldId(OBJ_THREAD, name);

/**
 * One conversation per (account, waId) — FR-THR-1, enforced by a unique index.
 *
 * Every entry point (inbound, campaign, workflow, rep-initiated template) goes
 * through one `upsertThread`, which is the mechanical guarantee that a template
 * send never spawns a duplicate conversation (FR-OUT-5).
 */
export default defineObject({
  universalIdentifier: OBJ_THREAD,
  nameSingular: 'whatsappThread',
  namePlural: 'whatsappThreads',
  labelSingular: 'WhatsApp conversation',
  labelPlural: 'WhatsApp conversations',
  description: 'A WhatsApp conversation with one contact',
  icon: 'IconMessageCircle',
  isUICreatable: false,
  /**
   * The phone number, not the profile name (D-67).
   *
   * The label identifier is what Twenty calls a record *everywhere it names
   * one* — most visibly in the Person timeline, which filled with "linked a
   * whatsapp conversation **Untitled**", one line per link, saying nothing.
   * `profileName` is the wrong field for the job: Meta sends `profile.name`
   * only on inbound and only when the contact has set one, so every
   * conversation a rep started had no label at all.
   *
   * `dialablePhone` is set for every thread on creation and is what a person
   * recognises a conversation by in the absence of a name. The chat surfaces
   * still prefer the profile name — see `threadName`, where the precedence is a
   * deliberate product decision — and are unaffected by this: nothing in the
   * app reads the label identifier.
   */
  labelIdentifierFieldMetadataUniversalIdentifier: f('dialablePhone'),
  fields: [
    {
      universalIdentifier: THREAD_PROFILE_NAME,
      name: 'profileName',
      label: 'Profile name',
      description: 'WhatsApp display name from contacts[].profile.name (FR-IN-4)',
      icon: 'IconUser',
      type: FieldType.TEXT,
      isNullable: true,
    },
    {
      universalIdentifier: f('waId'),
      name: 'waId',
      label: 'WhatsApp ID',
      description:
        "Meta's identity for the contact. NOT assumed equal to the dialable number — Argentina and Mexico differ (FR-CID-2)",
      icon: 'IconHash',
      type: FieldType.TEXT,
      defaultValue: "''",
    },
    {
      universalIdentifier: f('dialablePhone'),
      name: 'dialablePhone',
      label: 'Phone',
      description: 'Normalised E.164 including +',
      icon: 'IconPhone',
      type: FieldType.TEXT,
      isNullable: true,
    },
    {
      universalIdentifier: f('status'),
      name: 'status',
      label: 'Status',
      icon: 'IconProgress',
      type: FieldType.SELECT,
      defaultValue: "'OPEN'",
      options: [
        { value: 'OPEN', label: 'Open', position: 0, color: 'green' },
        { value: 'AWAITING_REPLY', label: 'Awaiting reply', position: 1, color: 'blue' },
        { value: 'CLOSED', label: 'Closed', position: 2, color: 'gray' },
        { value: 'NEEDS_REVIEW', label: 'Needs review', position: 3, color: 'orange' },
      ],
    },
    {
      universalIdentifier: f('lastInboundAt'),
      name: 'lastInboundAt',
      label: 'Last inbound',
      description: 'Drives the 24h customer service window',
      icon: 'IconArrowDown',
      type: FieldType.DATE_TIME,
      isNullable: true,
    },
    {
      universalIdentifier: f('lastOutboundAt'),
      name: 'lastOutboundAt',
      label: 'Last outbound',
      description: 'Also drives per-recipient spacing against Meta error 131056',
      icon: 'IconArrowUp',
      type: FieldType.DATE_TIME,
      isNullable: true,
    },
    {
      universalIdentifier: f('lastMessageAt'),
      name: 'lastMessageAt',
      label: 'Last activity',
      description: 'Inbox sort key, denormalised so sorting never touches the message table',
      icon: 'IconClock',
      type: FieldType.DATE_TIME,
      isNullable: true,
    },
    {
      universalIdentifier: f('serviceWindowExpiresAt'),
      name: 'serviceWindowExpiresAt',
      label: 'Window expires',
      description: 'lastInboundAt + 24h, or +72h for a Click-to-WhatsApp conversation',
      icon: 'IconHourglass',
      type: FieldType.DATE_TIME,
      isNullable: true,
    },
    {
      universalIdentifier: f('windowState'),
      name: 'windowState',
      label: 'Window',
      description:
        'Denormalised cache for filtering, swept every 15 min. The server never trusts it for a send decision (specs/04 §1.1)',
      icon: 'IconWindow',
      type: FieldType.SELECT,
      defaultValue: "'EXPIRED'",
      options: [
        { value: 'OPEN', label: 'Open', position: 0, color: 'green' },
        { value: 'EXPIRED', label: 'Expired', position: 1, color: 'gray' },
      ],
    },
    {
      universalIdentifier: f('windowKind'),
      name: 'windowKind',
      label: 'Window kind',
      icon: 'IconAd',
      type: FieldType.SELECT,
      defaultValue: "'STANDARD'",
      options: [
        { value: 'STANDARD', label: 'Standard (24h)', position: 0, color: 'gray' },
        { value: 'FREE_ENTRY_POINT', label: 'Free entry point (72h)', position: 1, color: 'purple' },
      ],
    },
    {
      universalIdentifier: f('unreadCount'),
      name: 'unreadCount',
      label: 'Unread',
      icon: 'IconMail',
      type: FieldType.NUMBER,
      defaultValue: 0,
    },
    {
      universalIdentifier: f('lastMessagePreview'),
      name: 'lastMessagePreview',
      label: 'Preview',
      description: 'Truncated to ~120 characters',
      icon: 'IconQuote',
      type: FieldType.TEXT,
      isNullable: true,
    },
    {
      universalIdentifier: f('lastMessageDirection'),
      name: 'lastMessageDirection',
      label: 'Last direction',
      icon: 'IconArrowsUpDown',
      type: FieldType.SELECT,
      isNullable: true,
      options: [
        { value: 'INBOUND', label: 'Inbound', position: 0, color: 'green' },
        { value: 'OUTBOUND', label: 'Outbound', position: 1, color: 'blue' },
      ],
    },
    {
      universalIdentifier: f('referral'),
      name: 'referral',
      label: 'Referral',
      description: 'Click-to-WhatsApp / free-entry-point payload (FR-IN-6)',
      icon: 'IconAd2',
      type: FieldType.RAW_JSON,
      isNullable: true,
    },
    {
      universalIdentifier: f('linkCandidates'),
      name: 'linkCandidates',
      label: 'Link candidates',
      description: 'Person ids considered when the match was ambiguous (FR-CID-5)',
      icon: 'IconUserQuestion',
      type: FieldType.RAW_JSON,
      isNullable: true,
    },
    {
      universalIdentifier: f('originCampaignId'),
      name: 'originCampaignId',
      label: 'Origin campaign',
      description:
        'Set when the first outbound was a campaign send. A plain id, not a relation, so deleting a campaign never cascades into conversation history (FR-CAM-13)',
      icon: 'IconSpeakerphone',
      type: FieldType.TEXT,
      isNullable: true,
    },
    {
      universalIdentifier: f('isBlocked'),
      name: 'isBlocked',
      label: 'Blocked',
      description: 'Manual suppression, independent of consent',
      icon: 'IconBan',
      type: FieldType.BOOLEAN,
      defaultValue: false,
    },
    {
      universalIdentifier: f('snoozedUntil'),
      name: 'snoozedUntil',
      label: 'Snoozed until',
      icon: 'IconZzz',
      type: FieldType.DATE_TIME,
      isNullable: true,
    },
  ],
});
