import { useEffect, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { ContactCardProjection } from '../../../domain/feed/content';
import type { PersonProjection } from '../../../domain/feed/projection';
import { isWorkspaceFileAddress } from '../../../domain/workspace-file';
import type { WorkspaceFileHit } from '../../common/actions';
import type { Translate } from '../../common/copy';
import { fileSize } from '../../common/format';
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
  /**
   * Search over the workspace's attachments, so "already in Twenty" starts as
   * a picker instead of an address to hunt down. Optional: without it the
   * panel is the address form it always was.
   */
  onFileSearch?: (query: string) => Promise<WorkspaceFileHit[] | null>;
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

type AttachmentSource = 'recent' | 'link';

/**
 * Sending a file: one already exchanged in this conversation, or one stored
 * in Twenty, by its address.
 *
 * There is deliberately no "from this device" source. The platform docs'
 * sentence — a file input exposes its metadata and not its bytes — held up in
 * production: a picked `File` crosses the sandbox bridge as a proxy with no
 * `Blob` methods (`e.arrayBuffer is not a function`, live), and `FileReader`,
 * though present (D-53), cannot read that proxy either. A device tab whose
 * every pick fails is worse than no tab, so the path was removed; see the
 * D-53 field correction in specs/00. The voice recorder still uploads fine
 * because its blob is *created inside* the sandbox, where `arrayBuffer()`
 * works.
 *
 * The URL path carries what the transcript does not (any workspace file, at
 * any size Meta accepts), and "recent" reuses a file already in the
 * conversation without asking anyone to find its address. The URL path opens
 * as a *picker* over the workspace's attachments (`fileSearch` on the thread
 * route) — choosing a row only fills the address, name and kind boxes, so the
 * send below it stays one thing and the boxes remain the escape hatch for a
 * file the search cannot see.
 */
export const AttachmentPanel = ({
  t,
  isSending,
  initialKind,
  recentFiles = [],
  onFileSearch,
  onCancel,
  onSend,
}: AttachmentPanelProps) => {
  const theme = useTheme();

  // A transcript with files opens on reuse; an empty one opens on the address.
  const [source, setSource] = useState<AttachmentSource>(
    recentFiles.length > 0 ? 'recent' : 'link',
  );

  // ── Recent ────────────────────────────────────────────────────────────────
  const [recent, setRecent] = useState<RecentAttachment | null>(null);

  // ── Link ──────────────────────────────────────────────────────────────────
  const [kind, setKind] = useState<'image' | 'video' | 'audio' | 'document'>(initialKind);
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');

  // ── The workspace-file picker inside the link source ──────────────────────
  const [fileQuery, setFileQuery] = useState('');
  /** `null` before the first answer and after a failed one — no list at all. */
  const [fileHits, setFileHits] = useState<WorkspaceFileHit[] | null>(null);
  const [fileSearching, setFileSearching] = useState(false);

  /**
   * Debounced like the campaign builder's contact search, with one deliberate
   * difference: an empty query *does* run, answering the newest files — the
   * file a rep wants is overwhelmingly the one just uploaded, so the picker
   * must open already useful.
   */
  useEffect(() => {
    if (source !== 'link' || onFileSearch === undefined) return;

    setFileSearching(true);

    let stale = false;
    const timer = setTimeout(() => {
      void onFileSearch(fileQuery.trim()).then((hits) => {
        if (stale) return;

        setFileSearching(false);
        setFileHits(hits);
      });
    }, 300);

    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [source, fileQuery, onFileSearch]);

  const [caption, setCaption] = useState('');
  const [attempted, setAttempted] = useState(false);

  const trimmed = url.trim();
  /**
   * Not merely "is this a URL" (D-58): the server only reads addresses inside
   * Twenty's file store, so anything else is a send that is already lost.
   */
  const wellFormed = isWorkspaceFileAddress(trimmed);

  /** What the send will actually carry, for the caption rule below. */
  const activeKind = source === 'recent' ? (recent?.mediaKind ?? null) : kind;

  const trimmedCaption = caption.trim();
  // Audio carries no caption; Meta rejects the field outright.
  const sendableCaption =
    activeKind === 'audio' || trimmedCaption.length === 0 ? null : trimmedCaption;

  const submit = () => {
    setAttempted(true);

    if (isSending) return;

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
          {(['recent', 'link'] as const).map((entry) => (
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
          {onFileSearch === undefined ? null : (
            <>
              <TextField
                id="wa-attach-file-search"
                label={t('chat.fileSearchLabel')}
                value={fileQuery}
                onChange={setFileQuery}
                t={t}
              />

              {fileSearching ? (
                <span
                  role="status"
                  style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}
                >
                  {t('chat.fileSearching')}
                </span>
              ) : fileHits === null ? null : fileHits.length === 0 ? (
                <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.tertiary }}>
                  {t('chat.fileSearchNone')}
                </span>
              ) : (
                /*
                  Six rows, not twenty: the panel shares the composer's column
                  and must not become the thing that scrolls the page. A file
                  outside the six is one typed letter away.
                */
                fileHits.slice(0, 6).map((hit) => {
                  const address = `/files/${hit.path}`;
                  const chosen = trimmed === address;

                  return (
                    <button
                      key={hit.id}
                      type="button"
                      onClick={() => {
                        setUrl(address);
                        setFilename(hit.name);
                        setKind(hit.mediaKind);
                        setAttempted(false);
                      }}
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
                      <Glyph name={hit.mediaKind} />
                      <span
                        style={{
                          flex: '1 1 auto',
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {hit.name}
                      </span>
                    </button>
                  );
                })
              )}
            </>
          )}

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
        submitLabel={t('chat.sendAttachment')}
        submitIcon="attachment"
        onCancel={onCancel}
        onSubmit={submit}
        disabled={
          isSending ||
          (source === 'recent' && recent === null) ||
          (source === 'link' && attempted && !wellFormed)
        }
        t={t}
      />
    </div>
  );
};
