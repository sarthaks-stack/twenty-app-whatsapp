import { useEffect, useMemo, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { useTheme } from 'twenty-ui/theme-constants';

import type { ContactCardProjection } from '../../../domain/feed/content';
import type { PersonProjection } from '../../../domain/feed/projection';
import { isWorkspaceFileAddress } from '../../../domain/workspace-file';
import type { Translate } from '../../common/copy';
import { fileSize } from '../../common/format';
import { Glyph } from '../../common/icons';
import { LocationContent } from '../renderers/rich';
import { PanelFooter, TextField } from './fields';
import {
  MAX_DEVICE_UPLOAD_BYTES,
  deviceMediaKind,
  uploadDeviceFile,
  validateDeviceFile,
  type DeviceFileVerdict,
} from './upload';

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

/** A file already exchanged in this conversation, offered for reuse. */
export type RecentAttachment = {
  url: string;
  filename: string | null;
  mediaKind: 'image' | 'video' | 'audio' | 'document';
  sizeBytes: number | null;
};

export type AttachmentPanelProps = {
  t: Translate;
  isSending: boolean;
  /** Photo/video and document open the same panel with a different default. */
  initialKind: 'image' | 'document';
  /** Files from this conversation's transcript, newest first. */
  recentFiles?: RecentAttachment[];
  onCancel: () => void;
  onSend: (input: {
    mediaKind: 'image' | 'video' | 'audio' | 'document';
    fileUrl?: string;
    filePath?: string;
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

type AttachmentSource = 'device' | 'recent' | 'link';

/** The verdict's sentence, in catalog words rather than the validator's English. */
const verdictCopy = (verdict: DeviceFileVerdict, size: number, t: Translate): string | null => {
  if (verdict.ok) return null;

  switch (verdict.reason) {
    case 'TOO_LARGE_FOR_UPLOAD':
      return t('chat.fileTooLargeUpload', {
        size: fileSize(size),
        limit: fileSize(MAX_DEVICE_UPLOAD_BYTES),
      });
    case 'MEDIA_TOO_LARGE':
      return t('chat.fileTooLargeMeta', { size: fileSize(size) });
    default:
      return t('chat.fileWrongType');
  }
};

/**
 * Sending a file: from the device, from this conversation, or by its Twenty
 * address.
 *
 * The device path exists because the spec sentence forbidding it was wrong.
 * "The sandbox exposes a file input's metadata and not its bytes, and
 * `FileReader` is unavailable" came from the platform docs; the D-53 probe
 * measured `FileReader` present, and a picked `File` is a `Blob` whose
 * `arrayBuffer()` the voice recorder was already using. So the picker feeds
 * the same authenticated upload route the recorder does — validated against
 * Meta's caps *before* any bytes move, with the caption written beside the
 * preview of the thing it will caption.
 *
 * The URL path stays for what direct upload cannot carry (the route caps at
 * 8 MB; a workspace file can be a 100 MB document), and "recent" reuses a file
 * already in the transcript without asking anyone to find its address.
 */
export const AttachmentPanel = ({
  t,
  isSending,
  initialKind,
  recentFiles = [],
  onCancel,
  onSend,
}: AttachmentPanelProps) => {
  const theme = useTheme();
  const client = useRef(new RestApiClient());

  const [source, setSource] = useState<AttachmentSource>('device');

  // ── Device ────────────────────────────────────────────────────────────────
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'reading' | 'uploading'>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ── Recent ────────────────────────────────────────────────────────────────
  const [recent, setRecent] = useState<RecentAttachment | null>(null);

  // ── Link ──────────────────────────────────────────────────────────────────
  const [kind, setKind] = useState<'image' | 'video' | 'audio' | 'document'>(initialKind);
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');

  const [caption, setCaption] = useState('');
  const [attempted, setAttempted] = useState(false);

  useEffect(
    () => () => {
      if (previewUrl !== null) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const deviceKind = file === null ? null : deviceMediaKind(file.type);
  /**
   * Judged on pick, not on send: a 40 MB video must be refused while the rep
   * can still choose another file, not after they wrote the caption.
   */
  const deviceVerdict = useMemo<DeviceFileVerdict | null>(
    () =>
      file === null || deviceKind === null
        ? null
        : validateDeviceFile({ kind: deviceKind, mimeType: file.type, sizeBytes: file.size }),
    [deviceKind, file],
  );

  const pick = (picked: File | null) => {
    setUploadError(null);
    setFile(picked);
    setPreviewUrl((current) => {
      if (current !== null) URL.revokeObjectURL(current);

      return picked !== null && deviceMediaKind(picked.type) === 'image'
        ? URL.createObjectURL(picked)
        : null;
    });
  };

  const trimmed = url.trim();
  /**
   * Not merely "is this a URL" (D-58): the server only reads addresses inside
   * Twenty's file store, so anything else is a send that is already lost.
   */
  const wellFormed = isWorkspaceFileAddress(trimmed);

  /** What the send will actually carry, for the caption rule below. */
  const activeKind =
    source === 'device' ? deviceKind : source === 'recent' ? (recent?.mediaKind ?? null) : kind;

  const trimmedCaption = caption.trim();
  // Audio carries no caption; Meta rejects the field outright.
  const sendableCaption =
    activeKind === 'audio' || trimmedCaption.length === 0 ? null : trimmedCaption;

  const busy = isSending || phase !== 'idle';

  const submitDevice = async () => {
    if (file === null || deviceKind === null || deviceVerdict === null) return;
    if (!deviceVerdict.ok || busy) return;

    setUploadError(null);

    try {
      const stored = await uploadDeviceFile({
        client: client.current,
        blob: file,
        filename: file.name,
        contentType: file.type,
        mediaKind: deviceKind,
        onPhase: setPhase,
      });

      onSend({
        mediaKind: deviceKind,
        ...(stored.fileUrl.length === 0 ? {} : { fileUrl: stored.fileUrl }),
        ...(stored.filePath.length === 0 ? {} : { filePath: stored.filePath }),
        filename: file.name,
        caption: sendableCaption,
      });
    } catch (caught) {
      setUploadError(
        caught instanceof Error && caught.message.length > 0
          ? caught.message
          : t('chat.uploadFailed'),
      );
    } finally {
      setPhase('idle');
    }
  };

  const submit = () => {
    setAttempted(true);

    if (busy) return;

    if (source === 'device') {
      void submitDevice();

      return;
    }

    if (source === 'recent') {
      if (recent === null) return;

      onSend({
        mediaKind: recent.mediaKind,
        fileUrl: recent.url,
        filename: recent.filename,
        caption: sendableCaption,
      });

      return;
    }

    if (!wellFormed) return;

    onSend({
      mediaKind: kind,
      fileUrl: trimmed,
      filename: filename.trim().length === 0 ? null : filename.trim(),
      caption: sendableCaption,
    });
  };

  const chip = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing[1],
    minHeight: '32px',
    border: `1px solid ${active ? theme.color.blue : theme.border.color.medium}`,
    borderRadius: theme.border.radius.sm,
    background: active ? theme.background.transparent.blue : 'transparent',
    color: theme.font.color.secondary,
    cursor: 'pointer',
    fontFamily: theme.font.family,
    fontSize: theme.font.size.xs,
    padding: `0 ${theme.spacing[2]}`,
  });

  const deviceProblem =
    deviceVerdict === null || file === null
      ? null
      : verdictCopy(deviceVerdict, file.size, t);

  const captionField = (
    <TextField
      id="wa-attach-caption"
      label={t('chat.captionLabel')}
      value={caption}
      rows={2}
      onChange={setCaption}
      t={t}
    />
  );

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
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[0.5] }}>
        <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
          {t('chat.sourceLabel')}
        </span>
        <div
          role="radiogroup"
          aria-label={t('chat.sourceLabel')}
          style={{ display: 'flex', gap: theme.spacing[1], flexWrap: 'wrap' }}
        >
          {(['device', 'recent', 'link'] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="radio"
              aria-checked={source === entry}
              onClick={() => {
                setSource(entry);
                setAttempted(false);
              }}
              style={chip(source === entry)}
            >
              {t(`chat.source.${entry}`)}
            </button>
          ))}
        </div>
      </div>

      {source === 'device' ? (
        <>
          <input
            type="file"
            aria-label={t('chat.chooseFile')}
            onChange={(event) => pick(event.target.files?.[0] ?? null)}
            style={{
              fontFamily: theme.font.family,
              fontSize: theme.font.size.sm,
              color: theme.font.color.secondary,
            }}
          />

          {file === null ? null : (
            <div
              style={{
                display: 'flex',
                gap: theme.spacing[2],
                alignItems: 'flex-start',
              }}
            >
              {/*
                The caption sits beside the thing it captions (UX review). A
                non-image file gets its name and size where the thumbnail
                would be, so the pair reads the same way for every kind.
              */}
              {previewUrl !== null ? (
                <img
                  src={previewUrl}
                  alt={file.name}
                  style={{
                    width: '96px',
                    height: '96px',
                    objectFit: 'cover',
                    borderRadius: theme.border.radius.sm,
                    border: `1px solid ${theme.border.color.light}`,
                    flex: '0 0 auto',
                  }}
                />
              ) : (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: theme.spacing[1],
                    fontSize: theme.font.size.sm,
                    color: theme.font.color.secondary,
                    flex: '0 0 auto',
                    maxWidth: '40%',
                    overflow: 'hidden',
                  }}
                >
                  <Glyph name="document" size="md" />
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {file.name}
                  </span>
                </span>
              )}

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.spacing[1],
                  flex: '1 1 auto',
                  minWidth: 0,
                }}
              >
                {deviceKind === 'audio' ? null : captionField}
                <span
                  style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}
                >
                  {t('chat.detectedKind', {
                    kind: t(`chat.type.${(deviceKind ?? 'document').toUpperCase()}`),
                    size: fileSize(file.size),
                  })}
                </span>
              </div>
            </div>
          )}

          {deviceProblem === null ? null : (
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
              {deviceProblem}
            </span>
          )}

          {phase === 'idle' ? null : (
            <span
              role="status"
              style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}
            >
              {phase === 'reading'
                ? t('chat.uploadReading')
                : t('chat.uploadUploading', { size: fileSize(file?.size ?? 0) })}
            </span>
          )}

          {uploadError === null ? null : (
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
              {uploadError}
            </span>
          )}
        </>
      ) : null}

      {source === 'recent' ? (
        recentFiles.length === 0 ? (
          <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.tertiary }}>
            {t('chat.recentNone')}
          </span>
        ) : (
          <>
            <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
              {t('chat.recentHint')}
            </span>
            {recentFiles.map((entry) => {
              const chosen = recent?.url === entry.url;

              return (
                <button
                  key={entry.url}
                  type="button"
                  onClick={() => setRecent(entry)}
                  aria-pressed={chosen}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.spacing[1],
                    minHeight: '32px',
                    border: `1px solid ${
                      chosen ? theme.color.blue : theme.border.color.light
                    }`,
                    borderRadius: theme.border.radius.sm,
                    background: chosen
                      ? theme.background.transparent.blue
                      : 'transparent',
                    color: theme.font.color.secondary,
                    cursor: 'pointer',
                    fontFamily: theme.font.family,
                    fontSize: theme.font.size.sm,
                    padding: `0 ${theme.spacing[2]}`,
                    textAlign: 'left',
                  }}
                >
                  <Glyph name={entry.mediaKind} />
                  <span
                    style={{
                      flex: '1 1 auto',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {entry.filename ?? t(`chat.type.${entry.mediaKind.toUpperCase()}`)}
                  </span>
                  {entry.sizeBytes === null ? null : (
                    <span
                      style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}
                    >
                      {fileSize(entry.sizeBytes)}
                    </span>
                  )}
                </button>
              );
            })}
            {recent === null || recent.mediaKind === 'audio' ? null : captionField}
          </>
        )
      ) : null}

      {source === 'link' ? (
        <>
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
                  style={chip(kind === entry.key)}
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

          {kind === 'audio' ? null : captionField}
        </>
      ) : null}

      <PanelFooter
        submitLabel={
          source === 'device' && phase !== 'idle'
            ? t('chat.sending')
            : t('chat.sendAttachment')
        }
        submitIcon="attachment"
        onCancel={onCancel}
        onSubmit={submit}
        disabled={
          busy ||
          (source === 'device' && (file === null || deviceVerdict?.ok !== true)) ||
          (source === 'recent' && recent === null) ||
          (source === 'link' && attempted && !wellFormed)
        }
        t={t}
      />
    </div>
  );
};
