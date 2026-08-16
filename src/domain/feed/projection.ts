import { ERROR_CATALOG, ERROR_CLASS } from '../../providers/whatsapp/errors';

/**
 * The wire shapes the front components render (specs/08 §2).
 *
 * Two rules govern what goes over this seam.
 *
 * **The server decides, the component renders.** `isRetryable` is computed from
 * the error catalogue here rather than in the browser, for the same reason
 * `policy` is (AR-17): one implementation of a rule, and a retry button that
 * cannot disagree with what the retry route will actually do.
 *
 * **Machine codes, never prose.** Nothing in these shapes is a sentence a user
 * reads. Copy lives in the component's pt/en tables (specs/01 §7), so a wording
 * change is never a server deploy.
 */

export type MediaProjection = {
  kind: string | null;
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  /** Signed, short-lived, and only ever handed to an authenticated caller. */
  url: string | null;
  /** D-8: too large to have been fetched automatically; the UI offers a download. */
  deferred: boolean;
  downloadFailed: boolean;
};

export type ReactionProjection = { waId: string; emoji: string };

export type MessageProjection = {
  id: string;
  wamid: string | null;
  direction: string | null;
  type: string | null;
  status: string | null;
  body: string | null;
  waTimestamp: string | null;
  createdAt: string | null;
  statusTimestamps: Record<string, unknown>;
  errorCode: string | null;
  errorDetail: string | null;
  retryCount: number;
  isRetryable: boolean;
  lane: string | null;
  sourceKind: string | null;
  templateName: string | null;
  templateLanguage: string | null;
  templateCategory: string | null;
  contextWamid: string | null;
  reactionTargetWamid: string | null;
  media: MediaProjection | null;
  reactions: ReactionProjection[];
  /** Location, contact cards, interactive structures — and the "Ver detalhes" fallback. */
  payload: Record<string, unknown> | null;
  clientToken: string | null;
  sentById: string | null;
  threadId: string | null;
};

type MessageSource = {
  id: string;
  wamid?: string | null;
  direction?: string | null;
  messageType?: string | null;
  body?: string | null;
  payload?: unknown;
  status?: string | null;
  statusTimestamps?: unknown;
  errorCode?: string | null;
  errorDetail?: string | null;
  retryCount?: number | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateCategory?: string | null;
  mediaMeta?: unknown;
  mediaFile?: unknown;
  contextWamid?: string | null;
  reactionTargetWamid?: string | null;
  waTimestamp?: string | null;
  lane?: string | null;
  sourceKind?: string | null;
  threadId?: string | null;
  sentById?: string | null;
  clientToken?: string | null;
  createdAt?: string | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);

      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return typeof value === 'object' ? (value as Record<string, unknown>) : null;
};

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Whether the **Repetir** action should appear (FR-OUT-4, FR-UI-6).
 *
 * Only `retryable_backoff` qualifies. A token problem is retryable for the
 * *system* once an admin fixes it, but offering a rep a button that will fail
 * again until someone else acts is worse than showing them the real reason —
 * and a terminal recipient error will never succeed no matter how many times
 * it is pressed. An unmapped or internal code answers false: no catalogue row
 * means no evidence that retrying is safe.
 */
export const isRetryableError = (errorCode: string | null | undefined): boolean => {
  if (typeof errorCode !== 'string' || errorCode.length === 0) return false;

  const numeric = Number(errorCode);

  if (!Number.isInteger(numeric)) return false;

  return ERROR_CATALOG.get(numeric)?.class === ERROR_CLASS.RETRYABLE_BACKOFF;
};

/**
 * The first stored file, if the media worker got one.
 *
 * `mediaFile` is a FILES column that arrives as `[{ fileId, label, url, … }]`
 * with a signed URL already attached, so the component needs no second call and
 * no knowledge of Twenty's file routes.
 */
const projectMedia = (source: MessageSource): MediaProjection | null => {
  const meta = asRecord(source.mediaMeta);
  const files = Array.isArray(source.mediaFile) ? source.mediaFile : [];
  const file = asRecord(files[0]);

  if (meta === null && file === null) return null;

  return {
    kind: stringOrNull(source.messageType),
    mimeType: stringOrNull(meta?.mimeType),
    fileName: stringOrNull(meta?.fileName) ?? stringOrNull(file?.label),
    sizeBytes: numberOrNull(meta?.fileSize),
    url: stringOrNull(file?.url),
    deferred: meta?.deferred === true,
    downloadFailed: meta?.downloadFailed === true,
  };
};

const projectReactions = (payload: Record<string, unknown> | null): ReactionProjection[] => {
  const raw = payload?.reactions;

  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => asRecord(entry))
    .map((entry) => ({
      waId: stringOrNull(entry?.waId) ?? '',
      emoji: stringOrNull(entry?.emoji) ?? '',
    }))
    .filter((reaction) => reaction.emoji.length > 0);
};

export const projectMessage = (source: MessageSource): MessageProjection => {
  const payload = asRecord(source.payload);

  return {
    id: source.id,
    wamid: stringOrNull(source.wamid),
    direction: stringOrNull(source.direction),
    type: stringOrNull(source.messageType),
    status: stringOrNull(source.status),
    body: typeof source.body === 'string' ? source.body : null,
    waTimestamp: stringOrNull(source.waTimestamp),
    createdAt: stringOrNull(source.createdAt),
    statusTimestamps: asRecord(source.statusTimestamps) ?? {},
    errorCode: stringOrNull(source.errorCode),
    errorDetail: stringOrNull(source.errorDetail),
    retryCount: numberOrNull(source.retryCount) ?? 0,
    isRetryable: isRetryableError(source.errorCode),
    lane: stringOrNull(source.lane),
    sourceKind: stringOrNull(source.sourceKind),
    templateName: stringOrNull(source.templateName),
    templateLanguage: stringOrNull(source.templateLanguage),
    templateCategory: stringOrNull(source.templateCategory),
    contextWamid: stringOrNull(source.contextWamid),
    reactionTargetWamid: stringOrNull(source.reactionTargetWamid),
    media: projectMedia(source),
    reactions: projectReactions(payload),
    payload,
    clientToken: stringOrNull(source.clientToken),
    sentById: stringOrNull(source.sentById),
    threadId: stringOrNull(source.threadId),
  };
};

export type ThreadProjection = {
  id: string;
  waId: string | null;
  profileName: string | null;
  dialablePhone: string | null;
  status: string | null;
  windowState: string | null;
  windowKind: string | null;
  serviceWindowExpiresAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: string | null;
  unreadCount: number;
  isBlocked: boolean;
  originCampaignId: string | null;
  accountId: string | null;
  personId: string | null;
  assigneeId: string | null;
  /** Present only when the thread needs a human to choose (FR-CID-5). */
  linkCandidates: Record<string, unknown> | null;
  referral: Record<string, unknown> | null;
  person: PersonProjection | null;
};

export type PersonProjection = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  city: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  whatsappOptInStatus: string | null;
  whatsappOptInUpdatedAt: string | null;
  companyId: string | null;
};

type PersonSource = {
  id: string;
  name?: { firstName?: string | null; lastName?: string | null } | null;
  jobTitle?: string | null;
  city?: string | null;
  emails?: { primaryEmail?: string | null } | null;
  phones?: {
    primaryPhoneNumber?: string | null;
    primaryPhoneCallingCode?: string | null;
  } | null;
  whatsappOptInStatus?: string | null;
  whatsappOptInUpdatedAt?: string | null;
  companyId?: string | null;
};

export const projectPerson = (source: PersonSource | null): PersonProjection | null => {
  if (source === null) return null;

  const callingCode = stringOrNull(source.phones?.primaryPhoneCallingCode) ?? '';
  const national = stringOrNull(source.phones?.primaryPhoneNumber) ?? '';

  return {
    id: source.id,
    firstName: stringOrNull(source.name?.firstName),
    lastName: stringOrNull(source.name?.lastName),
    jobTitle: stringOrNull(source.jobTitle),
    city: stringOrNull(source.city),
    primaryEmail: stringOrNull(source.emails?.primaryEmail),
    primaryPhone: national.length === 0 ? null : `${callingCode}${national}`,
    whatsappOptInStatus: stringOrNull(source.whatsappOptInStatus),
    whatsappOptInUpdatedAt: stringOrNull(source.whatsappOptInUpdatedAt),
    companyId: stringOrNull(source.companyId),
  };
};

type ThreadSource = {
  id: string;
  waId?: string | null;
  profileName?: string | null;
  dialablePhone?: string | null;
  status?: string | null;
  windowState?: string | null;
  windowKind?: string | null;
  serviceWindowExpiresAt?: string | null;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
  lastMessageDirection?: string | null;
  unreadCount?: number | null;
  isBlocked?: boolean | null;
  originCampaignId?: string | null;
  accountId?: string | null;
  personId?: string | null;
  assigneeId?: string | null;
  linkCandidates?: unknown;
  referral?: unknown;
};

export const projectThread = (
  source: ThreadSource,
  person: PersonProjection | null = null,
): ThreadProjection => ({
  id: source.id,
  waId: stringOrNull(source.waId),
  profileName: stringOrNull(source.profileName),
  dialablePhone: stringOrNull(source.dialablePhone),
  status: stringOrNull(source.status),
  windowState: stringOrNull(source.windowState),
  windowKind: stringOrNull(source.windowKind),
  serviceWindowExpiresAt: stringOrNull(source.serviceWindowExpiresAt),
  lastInboundAt: stringOrNull(source.lastInboundAt),
  lastOutboundAt: stringOrNull(source.lastOutboundAt),
  lastMessageAt: stringOrNull(source.lastMessageAt),
  lastMessagePreview: stringOrNull(source.lastMessagePreview),
  lastMessageDirection: stringOrNull(source.lastMessageDirection),
  unreadCount: numberOrNull(source.unreadCount) ?? 0,
  isBlocked: source.isBlocked === true,
  originCampaignId: stringOrNull(source.originCampaignId),
  accountId: stringOrNull(source.accountId),
  personId: stringOrNull(source.personId),
  assigneeId: stringOrNull(source.assigneeId),
  linkCandidates: asRecord(source.linkCandidates),
  referral: asRecord(source.referral),
  person,
});

export type AccountProjection = {
  id: string;
  name: string | null;
  status: string | null;
  statusDetail: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  tierUniqueUsersUsed: number;
  displayPhoneNumber: string | null;
  displayName: string | null;
  isTestAccount: boolean;
  webhookLastEventAt: string | null;
  webhookLastVerifiedAt: string | null;
  tokenLastCheckedAt: string | null;
};

type AccountSource = {
  id: string;
  name?: string | null;
  status?: string | null;
  statusDetail?: string | null;
  qualityRating?: string | null;
  messagingLimitTier?: string | null;
  tierUniqueUsersUsed?: number | null;
  displayPhoneNumber?: string | null;
  displayName?: string | null;
  isTestAccount?: boolean | null;
  webhookLastEventAt?: string | null;
  webhookLastVerifiedAt?: string | null;
  tokenLastCheckedAt?: string | null;
};

/**
 * The account block never carries `phoneNumberId` or `wabaId`.
 *
 * They are not secrets, but they are the routing identity of the number and the
 * front end has no use for either — the banner needs quality, status and the
 * test-account flag (FR-UI-6, FR-ACC-5). Settings asks for the rest through its
 * own admin route, which checks the admin role first.
 */
export const projectAccount = (source: AccountSource | null): AccountProjection | null =>
  source === null
    ? null
    : {
        id: source.id,
        name: stringOrNull(source.name),
        status: stringOrNull(source.status),
        statusDetail: stringOrNull(source.statusDetail),
        qualityRating: stringOrNull(source.qualityRating),
        messagingLimitTier: stringOrNull(source.messagingLimitTier),
        tierUniqueUsersUsed: numberOrNull(source.tierUniqueUsersUsed) ?? 0,
        displayPhoneNumber: stringOrNull(source.displayPhoneNumber),
        displayName: stringOrNull(source.displayName),
        isTestAccount: source.isTestAccount === true,
        webhookLastEventAt: stringOrNull(source.webhookLastEventAt),
        webhookLastVerifiedAt: stringOrNull(source.webhookLastVerifiedAt),
        tokenLastCheckedAt: stringOrNull(source.tokenLastCheckedAt),
      };
