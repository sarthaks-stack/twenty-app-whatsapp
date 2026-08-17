import { useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { ContactCardProjection } from '../../../domain/feed/content';
import type { PersonProjection } from '../../../domain/feed/projection';
import { isWorkspaceFileAddress } from '../../../domain/workspace-file';
import type { Translate } from '../../common/copy';
import { Glyph } from '../../common/icons';
import { LocationContent } from '../renderers/rich';
import { PanelFooter, TextField } from './fields';

/**
 * The three sends that need a small form rather than a text box: a location, a
 * contact card, and a file that already lives in Twenty.
 *
 * All three follow the same rule as the interactive builders — validate before
 * queueing, because a message that becomes a `QUEUED` row and then fails inside
 * the sender is a bubble the rep believes was sent.
 */

export type LocationPanelProps = {
  t: Translate;
  isSending: boolean;
  onCancel: () => void;
  onSend: (location: {
    latitude: number;
    longitude: number;
    name: string | null;
    address: string | null;
  }) => void;
};

const finite = (value: string): number | null => {
  const trimmed = value.trim().replace(',', '.');

  if (trimmed.length === 0) return null;

  const parsed = Number(trimmed);

  return Number.isFinite(parsed) ? parsed : null;
};

export const LocationPanel = ({ t, isSending, onCancel, onSend }: LocationPanelProps) => {
  const theme = useTheme();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [attempted, setAttempted] = useState(false);

  const lat = finite(latitude);
  const lon = finite(longitude);

  /**
   * The same range check the route runs. A transposed pair is accepted by Meta
   * and drops the customer in the Atlantic — the silent failure FR-CID-2 treats
   * as the worst kind — so it is refused in both places rather than trusted to
   * either.
   */
  const valid =
    lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

  const submit = () => {
    setAttempted(true);

    if (!valid || isSending) return;

    onSend({
      latitude: lat,
      longitude: lon,
      name: name.trim().length === 0 ? null : name.trim(),
      address: address.trim().length === 0 ? null : address.trim(),
    });
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        padding: theme.spacing[2],
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
      }}
    >

      <div style={{ display: 'flex', gap: theme.spacing[2], flexWrap: 'wrap' }}>
        <span style={{ flex: '1 1 120px', minWidth: 0 }}>
          <TextField
            id="wa-location-latitude"
            label={t('chat.latitude')}
            value={latitude}
            inputMode="decimal"
            placeholder="-8.9126"
            onChange={setLatitude}
            t={t}
          />
        </span>
        <span style={{ flex: '1 1 120px', minWidth: 0 }}>
          <TextField
            id="wa-location-longitude"
            label={t('chat.longitude')}
            value={longitude}
            inputMode="decimal"
            placeholder="13.2334"
            onChange={setLongitude}
            t={t}
          />
        </span>
      </div>

      <TextField
        id="wa-location-name"
        label={t('chat.locationName')}
        value={name}
        onChange={setName}
        t={t}
      />
      <TextField
        id="wa-location-address"
        label={t('chat.locationAddress')}
        value={address}
        onChange={setAddress}
        t={t}
      />

      {attempted && !valid ? (
        <span
          role="alert"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            fontSize: theme.font.size.xs,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="warning" />
          {t('chat.coordinatesRequired')}
        </span>
      ) : null}

      {/* The transcript's own card, so the preview cannot describe it differently. */}
      {valid ? (
        <LocationContent
          name={name.trim().length === 0 ? null : name.trim()}
          address={address.trim().length === 0 ? null : address.trim()}
          latitude={lat}
          longitude={lon}
          t={t}
        />
      ) : null}

      <PanelFooter
        submitLabel={t('chat.sendLocation')}
        onCancel={onCancel}
        onSubmit={submit}
        disabled={isSending || (attempted && !valid)}
        t={t}
      />
    </div>
  );
};

export type ContactPanelProps = {
  t: Translate;
  isSending: boolean;
  /** The conversation's own CRM contact, offered as a one-tap starting point. */
  person: PersonProjection | null;
  onCancel: () => void;
  onSend: (contact: ContactCardProjection) => void;
};

export const ContactPanel = ({
  t,
  isSending,
  person,
  onCancel,
  onSend,
}: ContactPanelProps) => {
  const theme = useTheme();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [organization, setOrganization] = useState('');
  const [attempted, setAttempted] = useState(false);

  const valid = name.trim().length > 0;

  const submit = () => {
    setAttempted(true);

    if (!valid || isSending) return;

    onSend({
      formattedName: name.trim(),
      firstName: name.trim().split(' ')[0] ?? null,
      lastName: null,
      organization: organization.trim().length === 0 ? null : organization.trim(),
      title: null,
      phones:
        phone.trim().length === 0
          ? []
          : [{ phone: phone.trim(), waId: null, type: 'CELL' }],
      emails: [],
    });
  };

  const personName = [person?.firstName, person?.lastName]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        padding: theme.spacing[2],
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
      }}
    >

      {/*
        A shortcut, not a picker. Twenty exposes no record-search widget to a
        front component, so offering "search your contacts" would be a control
        that could not be built — where prefilling from the conversation's own
        person is one tap and always correct.
      */}
      {personName.length === 0 ? null : (
        <button
          type="button"
          onClick={() => {
            setName(personName);
            setPhone(person?.primaryPhone ?? '');
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            alignSelf: 'flex-start',
            gap: theme.spacing[1],
            minHeight: '32px',
            border: `1px solid ${theme.border.color.medium}`,
            borderRadius: theme.border.radius.sm,
            background: 'transparent',
            color: theme.font.color.secondary,
            cursor: 'pointer',
            fontFamily: theme.font.family,
            fontSize: theme.font.size.xs,
            padding: `0 ${theme.spacing[2]}`,
          }}
        >
          <Glyph name="mine" />
          {t('chat.useThisPerson')}: {personName}
        </button>
      )}

      <TextField
        id="wa-contact-name"
        label={t('chat.contactName')}
        value={name}
        onChange={setName}
        t={t}
      />
      <TextField
        id="wa-contact-phone"
        label={t('chat.contactPhone')}
        value={phone}
        inputMode="tel"
        onChange={setPhone}
        t={t}
      />
      <TextField
        id="wa-contact-organization"
        label={t('chat.contactOrganization')}
        value={organization}
        onChange={setOrganization}
        t={t}
      />

      {attempted && !valid ? (
        <span
          role="alert"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            fontSize: theme.font.size.xs,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="warning" />
          {t('chat.contactNameRequired')}
        </span>
      ) : null}

      <PanelFooter
        submitLabel={t('chat.sendContact')}
        onCancel={onCancel}
        onSubmit={submit}
        disabled={isSending || (attempted && !valid)}
        t={t}
      />
    </div>
  );
};

export type AttachmentPanelProps = {
  t: Translate;
  isSending: boolean;
  /** Photo/video and document open the same panel with a different default. */
  initialKind: 'image' | 'document';
  onCancel: () => void;
  onSend: (input: {
    mediaKind: 'image' | 'video' | 'audio' | 'document';
    fileUrl: string;
    filename: string | null;
    caption: string | null;
  }) => void;
};

const KINDS: { key: 'image' | 'video' | 'audio' | 'document'; label: string }[] = [
  { key: 'image', label: 'chat.type.IMAGE' },
  { key: 'video', label: 'chat.type.VIDEO' },
  { key: 'audio', label: 'chat.type.AUDIO' },
  { key: 'document', label: 'chat.type.DOCUMENT' },
];

/**
 * Sending a file that is already in Twenty (spec §"Attachment and file-picker
 * feasibility").
 *
 * There is no device picker here, and that is a platform fact rather than a
 * shortcut: Twenty's front-component sandbox exposes a file input's *metadata*
 * and not its bytes, and `FileReader` is unavailable — so a picker would let a
 * rep choose a file and then fail after the choice, which the spec explicitly
 * asks not to ship. What works today is a file already stored in the workspace,
 * addressed by its URL, which the send route resolves and uploads server-side.
 *
 * The panel says so in a sentence, rather than leaving a rep to discover the
 * limit by hitting it.
 */
export const AttachmentPanel = ({
  t,
  isSending,
  initialKind,
  onCancel,
  onSend,
}: AttachmentPanelProps) => {
  const theme = useTheme();
  const [kind, setKind] = useState<'image' | 'video' | 'audio' | 'document'>(initialKind);
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [caption, setCaption] = useState('');
  const [attempted, setAttempted] = useState(false);

  const trimmed = url.trim();
  /**
   * Not merely "is this a URL" (D-58).
   *
   * The server will only read an address inside Twenty's file store, so a
   * well-formed URL pointing anywhere else — a public image, a Drive link, a
   * Meta CDN address out of a webhook — is a send that is already lost. Every
   * outbound attachment failed for a variant of this, and the panel accepted
   * all of them. The same rule the route applies, applied before the rep
   * presses send.
   */
  const wellFormed = isWorkspaceFileAddress(trimmed);

  const submit = () => {
    setAttempted(true);

    if (!wellFormed || isSending) return;

    onSend({
      mediaKind: kind,
      fileUrl: trimmed,
      filename: filename.trim().length === 0 ? null : filename.trim(),
      caption:
        kind === 'audio' || caption.trim().length === 0 ? null : caption.trim(),
    });
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        padding: theme.spacing[2],
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
      }}
    >
      {/*
        The platform limit, stated before a rep goes looking for a file picker
        that cannot exist here (spec §"Attachment and file-picker feasibility").
      */}
      <p
        style={{ margin: 0, fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}
      >
        {t('chat.deviceUploadUnavailable')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[0.5] }}>
        <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
          {t('chat.mediaKindLabel')}
        </span>
        <div
          role="radiogroup"
          aria-label={t('chat.mediaKindLabel')}
          style={{ display: 'flex', gap: theme.spacing[1], flexWrap: 'wrap' }}
        >
          {KINDS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="radio"
              aria-checked={kind === entry.key}
              onClick={() => setKind(entry.key)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: theme.spacing[1],
                minHeight: '32px',
                border: `1px solid ${
                  kind === entry.key ? theme.color.blue : theme.border.color.medium
                }`,
                borderRadius: theme.border.radius.sm,
                background:
                  kind === entry.key ? theme.background.transparent.blue : 'transparent',
                color: theme.font.color.secondary,
                cursor: 'pointer',
                fontFamily: theme.font.family,
                fontSize: theme.font.size.xs,
                padding: `0 ${theme.spacing[2]}`,
              }}
            >
              {t(entry.label)}
            </button>
          ))}
        </div>
      </div>

      <TextField
        id="wa-attach-url"
        label={t('chat.fileUrlLabel')}
        value={url}
        inputMode="url"
        onChange={setUrl}
        t={t}
        {...(attempted && !wellFormed
          ? {
              error: {
                field: 'fileUrl',
                code: trimmed.length === 0 ? 'REQUIRED' : 'NOT_A_FILE_URL',
              },
            }
          : {})}
      />
      <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
        {t('chat.fileUrlHint')}
      </span>

      <TextField
        id="wa-attach-filename"
        label={t('chat.fileNameLabel')}
        value={filename}
        onChange={setFilename}
        t={t}
      />

      {/* Stickers and audio carry no caption; Meta rejects the field outright. */}
      {kind === 'audio' ? null : (
        <TextField
          id="wa-attach-caption"
          label={t('chat.captionLabel')}
          value={caption}
          rows={2}
          onChange={setCaption}
          t={t}
        />
      )}

      <PanelFooter
        submitLabel={t('chat.sendAttachment')}
        submitIcon="attachment"
        onCancel={onCancel}
        onSubmit={submit}
        disabled={isSending || (attempted && !wellFormed)}
        t={t}
      />
    </div>
  );
};
