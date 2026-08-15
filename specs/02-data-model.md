# 02 — Data model

Implements TRD §8, AR-4, D-11, D-12.

Conventions used in every table below:

- **Type** is a `FieldType` member from `twenty-sdk/define`.
- **Null** — `Y` means `isNullable: true`. Relations and `TS_VECTOR` are always nullable.
- **Default** follows Twenty's quoting rule: string literals are double-quoted around a
  single-quoted value (`"'queued'"`); computed defaults are bare (`'now'`).
- All field universal identifiers are derived (`fieldId(OBJECT_UID, name)`), never literal.
- `id`, `createdAt`, `updatedAt`, `deletedAt`, `createdBy`, `updatedBy`, `position`,
  `searchVector` are provided by the platform and are not listed.

---

## 1. `whatsappAccount` — `OBJ_ACCOUNT`

One record per registered Meta business phone number (FR-ACC-1, FR-ACC-6, A-1).
`labelIdentifier` = `name`. `isUICreatable: false` — accounts are created only by
`wa-account-admin-route` so the kv claim (D-3) and the record can never diverge.

| Field | Type | Null | Default | Notes |
|---|---|---|---|---|
| `name` | TEXT | N | `"''"` | Label, e.g. "Vendas — Luanda". Label identifier. |
| `phoneNumberId` | TEXT | N | — | Meta `phone_number_id`. `isUnique: true`. Never the raw number. |
| `wabaId` | TEXT | N | — | WhatsApp Business Account id. |
| `displayPhoneNumber` | TEXT | Y | — | Human-readable `+244 …`, from `GET /{phone_number_id}`. |
| `displayName` | TEXT | Y | — | Approved WhatsApp display name. |
| `status` | SELECT | N | `"'pending'"` | `pending` / `connected` / `error` / `disabled`. |
| `statusDetail` | TEXT | Y | — | Last error reason when `status = error` (FR-ACC-4). |
| `qualityRating` | SELECT | N | `"'unknown'"` | `green` / `yellow` / `red` / `unknown` (FR-ACC-3). |
| `messagingLimitTier` | SELECT | N | `"'tier_250'"` | `tier_250` / `tier_1k` / `tier_2k` / `tier_10k` / `tier_100k` / `tier_unlimited`. Values are identifiers, not numbers, so a Meta tier change is a data edit. |
| `tierUniqueUsersUsed` | NUMBER | N | `0` | Rolling-24h business-initiated unique users (AR-21). |
| `tierWindowStartedAt` | DATE_TIME | Y | — | Start of the current rolling counter window. |
| `throughputPerSecond` | NUMBER | N | `80` | Meta-reported ceiling, informational. |
| `sendThrottlePerSecond` | NUMBER | N | `20` | Our ceiling (AR-12). |
| `interactiveCursorAt` | DATE_TIME | Y | — | Pacing cursor, interactive lane (D-5). |
| `campaignCursorAt` | DATE_TIME | Y | — | Pacing cursor, campaign lane (D-5). |
| `webhookLastEventAt` | DATE_TIME | Y | — | Liveness (FR-ACC-2/4). |
| `webhookLastVerifiedAt` | DATE_TIME | Y | — | Last successful GET handshake. |
| `tokenLastCheckedAt` | DATE_TIME | Y | — | Last successful `GET /{phone_number_id}` (FR-ACC-4). |
| `defaultCountryCallingCode` | TEXT | N | `"'+244'"` | Normalisation default (FR-CID-1). |
| `isTestAccount` | BOOLEAN | N | `false` | FR-ACC-5; renders a badge on every surface. |
| `contactAutoCreationEnabled` | BOOLEAN | N | `true` | FR-CID-3 toggle. |
| `autoAssignStrategy` | SELECT | N | `"'none'"` | `none` / `round_robin` (FR-THR-4). |
| `lastAssignedIndex` | NUMBER | N | `0` | Round-robin cursor. |

**Relations (own side):** `threads` (1-N → whatsappThread), `templates` (1-N → whatsappTemplate),
`campaigns` (1-N → whatsappCampaign), `assignmentGroup` (N-N to workspaceMember is not supported;
FR-THR-4's agent group is stored as `assignmentMemberIds` `ARRAY` of workspace member ids — a
deliberate simplification, documented in [05](05-identity-threads-window.md)).

**Index:** `IDX_ACCOUNT_PHONE_NUMBER_ID` — unique on `phoneNumberId`.

---

## 2. `whatsappThread` — `OBJ_THREAD`

One conversation per (`account`, `waId`) — FR-THR-1. `labelIdentifier` = `profileName`.

| Field | Type | Null | Default | Notes |
|---|---|---|---|---|
| `waId` | TEXT | N | — | WhatsApp identity from webhooks. **Not** assumed equal to the dialable number (FR-CID-2). |
| `profileName` | TEXT | Y | — | `contacts[].profile.name` (FR-IN-4). Label identifier. |
| `dialablePhone` | TEXT | Y | — | Normalised E.164 including `+`. |
| `status` | SELECT | N | `"'open'"` | `open` / `awaiting_reply` / `closed` / `needs_review` (FR-THR-2, FR-CID-5). |
| `lastInboundAt` | DATE_TIME | Y | — | Drives the CSW. |
| `lastOutboundAt` | DATE_TIME | Y | — | Also drives 131056 spacing (D-5). |
| `lastMessageAt` | DATE_TIME | Y | — | Sort key for the inbox. |
| `serviceWindowExpiresAt` | DATE_TIME | Y | — | `lastInboundAt + 24h`, or `+72h` for FEP. |
| `windowState` | SELECT | N | `"'expired'"` | `open` / `expired`. Denormalised for filtering; swept every 15 min (FR-THR-5). |
| `windowKind` | SELECT | N | `"'standard'"` | `standard` / `free_entry_point` (FR-IN-6). |
| `unreadCount` | NUMBER | N | `0` | Reset by `wa-thread-actions-route` `markRead`. |
| `lastMessagePreview` | TEXT | Y | — | ≤120 chars, plain text; media becomes `📷 Imagem` etc. |
| `lastMessageDirection` | SELECT | Y | — | `inbound` / `outbound`; used for the inbox preview prefix. |
| `referral` | RAW_JSON | Y | — | CTWA / FEP payload (FR-IN-6). |
| `linkCandidates` | RAW_JSON | Y | — | Person ids considered when `status = needs_review` (FR-CID-5). |
| `originCampaignId` | TEXT | Y | — | Set when the thread's first outbound was a campaign send (FR-CAM-13). Plain id, not a relation, to keep campaign deletion from cascading into conversation history. |
| `isBlocked` | BOOLEAN | N | `false` | Manual suppression independent of consent. |

**Relations:** `account` (N-1 → whatsappAccount, `onDelete: CASCADE`),
`person` (N-1 → person, `onDelete: SET_NULL`), `assignee` (N-1 → workspaceMember,
`onDelete: SET_NULL`), `messages` (1-N → whatsappMessage).

`person` is nullable: a thread in `needs_review` or created before matching has no Person yet
(FR-CID-5). Deleting a Person must not delete the conversation — `SET_NULL` here, with the
GDPR cascade handled explicitly by the erasure routine (SEC-8), not by the FK.

**Index:** `IDX_THREAD_ACCOUNT_WAID` — unique on (`accountId`, `waId`).

---

## 3. `whatsappMessage` — `OBJ_MESSAGE`

The high-volume table (NFR-S1: 50 000/day design headroom).
`labelIdentifier` = `body`. `isUICreatable: false`, `isUIEditable: false` — messages are only
ever written by the app (a hand-edited message record would desynchronise from Meta).

| Field | Type | Null | Default | Notes |
|---|---|---|---|---|
| `wamid` | TEXT | Y | — | `isUnique: true`. Null between `queued` and `accepted` for outbound. |
| `direction` | SELECT | N | — | `inbound` / `outbound`. |
| `type` | SELECT | N | `"'text'"` | `text`, `image`, `audio`, `video`, `document`, `sticker`, `location`, `contacts`, `reaction`, `interactive`, `button_reply`, `list_reply`, `template`, `system`, `unsupported`. |
| `body` | TEXT | Y | — | Text or caption; for `unsupported`, the placeholder string (FR-IN-1). |
| `payload` | RAW_JSON | Y | — | Full typed payload: coordinates, contact cards, interactive structures, reaction emoji. |
| `status` | SELECT | N | `"'queued'"` | `queued` / `accepted` / `sent` / `delivered` / `read` / `played` / `failed`. Monotonic (AR-9). Inbound messages are created directly at `delivered`. |
| `statusTimestamps` | RAW_JSON | Y | — | `{ accepted?, sent?, delivered?, read?, played?, failed? }` epoch seconds. Every observed transition is recorded even when the status field does not move (AR-9). |
| `errorCode` | TEXT | Y | — | Meta numeric code as a string (`'131047'`). |
| `errorDetail` | TEXT | Y | — | Meta `title`/`details`, raw, untranslated (see 01 §7). |
| `retryCount` | NUMBER | N | `0` | Send attempts consumed (AR-13). |
| `templateParameters` | RAW_JSON | Y | — | Resolved variables (FR-TPL-5). |
| `templateName` | TEXT | Y | — | Denormalised so audit survives template deletion. |
| `templateLanguage` | TEXT | Y | — | ditto. |
| `templateCategory` | SELECT | Y | — | `marketing` / `utility` / `authentication` — the billing driver (FR-TPL-5). |
| `billableCostUsd` | NUMBER | Y | — | Written on `delivered` for billable categories (FR-CAM-10, FR-TL-3). |
| `mediaFile` | FILES | Y | — | Stored inbound/outbound media (AR-15). |
| `mediaMeta` | RAW_JSON | Y | — | `{ mediaId, mimeType, fileSize, sha256, filename?, deferred?, downloadFailed?, downloadAttempts }`. |
| `contextWamid` | TEXT | Y | — | Quoted-reply reference (FR-OUT-3). |
| `reactionTargetWamid` | TEXT | Y | — | For `type = reaction` (FR-IN-4). |
| `waTimestamp` | DATE_TIME | N | `'now'` | Meta's timestamp; the chat ordering key. |
| `lane` | SELECT | N | `"'interactive'"` | `interactive` / `campaign` (D-5). |
| `sourceKind` | SELECT | N | `"'agent'"` | `agent` / `workflow` / `campaign` / `system` — audit of what caused the send. |

**Relations:** `thread` (N-1 → whatsappThread, `onDelete: CASCADE`),
`template` (N-1 → whatsappTemplate, `onDelete: SET_NULL`),
`sentBy` (N-1 → workspaceMember, `onDelete: SET_NULL`, FR-OUT-6),
`campaignRecipient` (1-1 modelled as N-1 from recipient; see §7).

**Indexes:** `IDX_MESSAGE_WAMID` unique on `wamid`; `IDX_MESSAGE_THREAD_TS` on
(`threadId`, `waTimestamp`) for pagination (NFR-P4).

### Why `reaction` is both a type and an update

FR-IN-4 requires reactions to attach to the referenced message rather than appear as thread
entries. Implementation: a reaction webhook creates a `whatsappMessage` row of
`type = 'reaction'` (so nothing is lost and the raw record is auditable) **and** patches the
target message's `payload.reactions` array. The chat renderer skips `type = 'reaction'` rows and
renders `payload.reactions` on the target bubble.

---

## 4. `whatsappTemplate` — `OBJ_TEMPLATE`

Mirror of Meta's template registry (FR-TPL-1). `labelIdentifier` = `name`.
`isUICreatable: false` — creation goes through `wa-template-sync` or the submit flow (FR-TPL-6),
never a hand-typed record.

| Field | Type | Null | Default | Notes |
|---|---|---|---|---|
| `metaTemplateId` | TEXT | N | — | Meta's id. Unique with `account`. |
| `name` | TEXT | N | — | Send key part 1. |
| `language` | TEXT | N | — | Send key part 2 (e.g. `pt_PT`). |
| `category` | SELECT | N | `"'utility'"` | `marketing` / `utility` / `authentication`. Meta-authoritative; may change on re-categorisation. |
| `previousCategory` | SELECT | Y | — | Set when a sync observes a category change, so admins see the reclassification (FR-TPL-6 note). |
| `status` | SELECT | N | `"'pending'"` | `pending` / `approved` / `rejected` / `paused` / `disabled` / `in_appeal`. |
| `rejectedReason` | TEXT | Y | — | From Meta when `rejected`. |
| `qualityScore` | SELECT | N | `"'unknown'"` | `green` / `yellow` / `red` / `unknown`. |
| `components` | RAW_JSON | N | `"'[]'"` | Meta component array verbatim. |
| `variableSpec` | RAW_JSON | Y | — | Derived at sync: `{ header: {type, count}, body: {count}, buttons: [...] }` — what the picker needs without re-parsing components in the browser. |
| `publishedToCrm` | BOOLEAN | N | `false` | Admin gate (FR-TPL-2). |
| `isUsableInCrm` | BOOLEAN | N | `true` | False when components are unsupported. |
| `unsupportedReason` | TEXT | Y | — | Why (FR-TPL-4), e.g. `FLOW_BUTTON`, `CAROUSEL`, `LTO`. |
| `lastSyncedAt` | DATE_TIME | Y | — | |
| `sentCount` / `deliveredCount` / `readCount` | NUMBER | N | `0` | Per-template analytics (FR-TPL-7, MAY), incremented by `wa-stats-rollup`. |

**Relations:** `account` (N-1 → whatsappAccount, `onDelete: CASCADE`),
`messages` (1-N → whatsappMessage), `campaigns` (1-N → whatsappCampaign).

**Index:** `IDX_TEMPLATE_ACCOUNT_META` — unique on (`accountId`, `metaTemplateId`).

---

## 5. `whatsappConsentEvent` — `OBJ_CONSENT_EVENT`

Append-only audit evidence (FR-CON-1). `isUIEditable: false`, `isUICreatable: false`.
`labelIdentifier` = `newStatus`.

| Field | Type | Null | Default | Notes |
|---|---|---|---|---|
| `newStatus` | SELECT | N | — | `opted_in` / `opted_out`. |
| `previousStatus` | SELECT | Y | — | `opted_in` / `opted_out` / `unknown`. |
| `method` | SELECT | N | `"'manual'"` | `keyword` / `manual` / `import` / `web_form` / `in_thread` / `api`. |
| `wordingShown` | TEXT | Y | — | Consent language presented to the contact — the evidence that matters (SEC-11). |
| `sourceReference` | TEXT | Y | — | WAMID of the triggering message, import filename, form URL. |
| `occurredAt` | DATE_TIME | N | `'now'` | |
| `notes` | TEXT | Y | — | Free text for manual changes. |

**Relations:** `person` (N-1 → person, `onDelete: CASCADE`),
`actor` (N-1 → workspaceMember, `onDelete: SET_NULL`; null for automatic keyword handling).

Consent events are never updated or deleted except by the SEC-8 erasure routine, which replaces
them with a single tombstone.

---

## 6. `whatsappCampaign` — `OBJ_CAMPAIGN`

FR-CAM-1…14. `labelIdentifier` = `name`.

| Field | Type | Null | Default | Notes |
|---|---|---|---|---|
| `name` | TEXT | N | `"''"` | |
| `status` | SELECT | N | `"'draft'"` | `draft` / `snapshotting` / `ready` / `scheduled` / `running` / `paused` / `tier_waiting` / `completed` / `cancelled` / `failed`. Two states beyond the TRD's list — see note below. |
| `statusReason` | TEXT | Y | — | Why paused/failed, e.g. `circuit_breaker`, `quality_red`, `tier_exhausted`. |
| `scheduledAt` | DATE_TIME | Y | — | Interpreted in `Africa/Luanda` at the UI layer; stored UTC. |
| `startedAt` / `completedAt` | DATE_TIME | Y | — | |
| `audienceDefinition` | RAW_JSON | N | `"'{}'"` | `{ kind: 'view' \| 'messageList' \| 'manual', viewId?, messageListId?, personIds?[], capturedAt }`. Provenance for the snapshot (FR-CAM-2, D-13). |
| `variableMapping` | RAW_JSON | N | `"'{}'"` | See §6.1. |
| `recipientCount` | NUMBER | N | `0` | Post-exclusion, i.e. what will actually be sent. |
| `excludedCount` | NUMBER | N | `0` | |
| `exclusionBreakdown` | RAW_JSON | Y | — | `{ opted_out: n, no_consent: n, invalid_phone: n, duplicate: n, missing_variables: n }` (FR-CAM-6). |
| `queuedCount` / `sentCount` / `deliveredCount` / `readCount` / `failedCount` / `skippedCount` / `respondedCount` | NUMBER | N | `0` | Live counters (FR-CAM-10). |
| `estimatedCostUsd` / `actualCostUsd` | NUMBER | Y | — | Appendix B rates. |
| `maxFailureRatePct` | NUMBER | N | `10` | Circuit breaker (AR-22). |
| `pacingObserved` | BOOLEAN | N | `false` | Set when Meta's marketing pacing is detected, to explain a slow run rather than alarm (FR-CAM-11, R-12). |
| `lastRunTickAt` | DATE_TIME | Y | — | Runner heartbeat (AR-20). |
| `testRecipientPhones` | ARRAY | Y | — | FR-CAM-12. |

**Relations:** `account` (N-1 → whatsappAccount, `onDelete: RESTRICT` — an account with campaigns
cannot be silently removed), `template` (N-1 → whatsappTemplate, `onDelete: RESTRICT`),
`createdBy` (N-1 → workspaceMember, SEC-12), `recipients` (1-N → whatsappCampaignRecipient).

> **Two added statuses.** `snapshotting` covers the minutes a 100 000-person audience takes to
> materialise (NFR-S4) — without it the UI cannot distinguish "still building" from "empty".
> `ready` is a snapshot that has been reviewed in pre-flight but not yet confirmed, which is
> what makes FR-CAM-6's explicit confirmation a state transition rather than a UI-only gesture.

### 6.1 `variableMapping` shape

```jsonc
{
  "header": { "kind": "media", "mediaId": "…", "fileId": "…" },      // or omitted
  "body": [
    { "index": 1, "kind": "field",  "path": "person.name.firstName", "fallback": "Cliente" },
    { "index": 2, "kind": "field",  "path": "person.company.name",   "fallback": null },
    { "index": 3, "kind": "static", "value": "Setembro" }
  ],
  "buttons": [ { "index": 0, "subType": "url", "kind": "field", "path": "person.id" } ]
}
```

`path` is resolved against a fixed, allow-listed projection of the Person record (see
[07-campaigns.md § Variable resolution](07-campaigns.md#4-variable-resolution)) — never an
arbitrary property walk over untrusted input.

---

## 7. `whatsappCampaignRecipient` — `OBJ_CAMPAIGN_RECIPIENT`

The snapshot row and the unit of idempotency (AR-20, FR-CAM-9).
`isUICreatable: false`, `isUIEditable: false`.

| Field | Type | Null | Default | Notes |
|---|---|---|---|---|
| `status` | SELECT | N | `"'pending'"` | `pending` / `excluded` / `claimed` / `queued` / `sent` / `delivered` / `read` / `failed` / `skipped` / `responded`. |
| `exclusionReason` | SELECT | Y | — | `opted_out` / `no_consent` / `invalid_phone` / `duplicate` / `missing_variables` / `blocked` (FR-CAM-3). |
| `resolvedParameters` | RAW_JSON | Y | — | Rendered variables, stored **before** send so a retry reuses identical content (FR-CAM-9). |
| `resolvedPhone` | TEXT | Y | — | E.164 at snapshot time; the audience is immutable even if the Person is edited. |
| `errorCode` / `errorDetail` | TEXT | Y | — | Meta error on failure/skip. |
| `claimedAt` | DATE_TIME | Y | — | Batch-claim lease (AR-20). |
| `sentAt` / `deliveredAt` / `readAt` / `respondedAt` | DATE_TIME | Y | — | |
| `attemptCount` | NUMBER | N | `0` | |

**Relations:** `campaign` (N-1 → whatsappCampaign, `onDelete: CASCADE`),
`person` (N-1 → person, `onDelete: CASCADE`),
`thread` (N-1 → whatsappThread, `onDelete: SET_NULL`),
`message` (N-1 → whatsappMessage, `onDelete: SET_NULL`).

**Indexes:** `IDX_RECIPIENT_CAMPAIGN_PERSON` unique on (`campaignId`, `personId`) — the guarantee
that no one is messaged twice by one campaign; `IDX_RECIPIENT_CAMPAIGN_STATUS` on
(`campaignId`, `status`) — the batch-claim query (AR-20) and the stats aggregation.

---

## 8. `whatsappWebhookEvent` — `OBJ_WEBHOOK_EVENT`

Raw log, replay surface and debug record (AR-7, §12.4). `isUIEditable: false`.
`labelIdentifier` = `dedupKey`.

| Field | Type | Null | Default | Notes |
|---|---|---|---|---|
| `dedupKey` | TEXT | N | — | `isUnique: true`. See §8.1. |
| `field` | TEXT | N | — | `messages`, `message_template_status_update`, … |
| `payload` | RAW_JSON | N | — | The single `changes[]` element, plus `{ _entryId, _receivedAt }`. |
| `processingStatus` | SELECT | N | `"'received'"` | `received` / `processed` / `failed` / `skipped_duplicate` / `unclaimed`. |
| `error` | TEXT | Y | — | Processor failure detail for replay. |
| `attemptCount` | NUMBER | N | `0` | |
| `receivedAt` | DATE_TIME | N | `'now'` | |
| `processedAt` | DATE_TIME | Y | — | |

**Index:** `IDX_WEBHOOK_DEDUPKEY` — unique on `dedupKey`.

Purged by `wa-retention-purge` after `WA_RETENTION_WEBHOOK_EVENT_DAYS` (default 30).
Because Meta offers no replay API beyond its own 7-day retry, this table is the **only** way to
reprocess history — retention below 7 days must be rejected by validation.

### 8.1 Dedup key construction (`src/domain/dedup-key.ts`)

| Change kind | Key |
|---|---|
| inbound message | `msg:{wamid}` |
| status event | `st:{wamid}:{status}` (a `failed` status also folds in the error code: `st:{wamid}:failed:{code}`) |
| template status/quality | `tpl:{message_template_id}:{event}:{timestamp}` |
| account / phone quality | `acct:{waba_id or phone_number_id}:{field}:{sha256(value)[0..16]}` |
| anything else | `raw:{sha256(field + JSON.stringify(value))}` |

Status keys deliberately include the status, so the legitimate `sent → delivered → read`
sequence produces three rows while a genuine duplicate produces one (AR-8).

---

## 9. Person extensions

Added with `defineField({ objectUniversalIdentifier: STANDARD_OBJECT.person.universalIdentifier, … })`
in `src/fields/`.

| Field | Type | Null | Default | Requirement |
|---|---|---|---|---|
| `whatsappOptInStatus` | SELECT | N | `"'unknown'"` | FR-CON-1. Options `opted_in` (green) / `opted_out` (red) / `unknown` (grey). |
| `whatsappOptInUpdatedAt` | DATE_TIME | Y | — | Denormalised from the latest consent event, for view filtering. |
| `whatsappThreads` | RELATION 1-N | — | — | Reverse side of `whatsappThread.person`. |
| `whatsappConsentEvents` | RELATION 1-N | — | — | Reverse side of `whatsappConsentEvent.person`. |
| `whatsappCampaignRecipients` | RELATION 1-N | — | — | Reverse side; enables "which campaigns did this person receive". |

No `whatsappPhone` field is added. Matching reads the standard `phones` composite
(`primaryPhoneNumber`, `primaryPhoneCallingCode`, `additionalPhones`) — TRD §2.1 — and the
WhatsApp-side identity lives on the thread (`waId`), because they are not always the same value
(FR-CID-2).

Company gets **no** custom fields; FR-CID-6 (company roll-up, MAY) is satisfied by a view over
`whatsappThread` filtered on `person.company`, not by denormalisation.

---

## 10. Relation inventory (D-11)

Each row is **two** files in `src/fields/`. `onDelete` is declared on the MANY_TO_ONE side only.

| Owner (N side) | Field | Target (1 side) | Reverse field | onDelete |
|---|---|---|---|---|
| whatsappThread | `account` | whatsappAccount | `threads` | CASCADE |
| whatsappThread | `person` | person | `whatsappThreads` | SET_NULL |
| whatsappThread | `assignee` | workspaceMember | `assignedWhatsappThreads` | SET_NULL |
| whatsappMessage | `thread` | whatsappThread | `messages` | CASCADE |
| whatsappMessage | `template` | whatsappTemplate | `messages` | SET_NULL |
| whatsappMessage | `sentBy` | workspaceMember | `sentWhatsappMessages` | SET_NULL |
| whatsappTemplate | `account` | whatsappAccount | `templates` | CASCADE |
| whatsappConsentEvent | `person` | person | `whatsappConsentEvents` | CASCADE |
| whatsappConsentEvent | `actor` | workspaceMember | `whatsappConsentActions` | SET_NULL |
| whatsappCampaign | `account` | whatsappAccount | `campaigns` | RESTRICT |
| whatsappCampaign | `template` | whatsappTemplate | `campaigns` | RESTRICT |
| whatsappCampaign | `createdBy` | workspaceMember | `createdWhatsappCampaigns` | SET_NULL |
| whatsappCampaignRecipient | `campaign` | whatsappCampaign | `recipients` | CASCADE |
| whatsappCampaignRecipient | `person` | person | `whatsappCampaignRecipients` | CASCADE |
| whatsappCampaignRecipient | `thread` | whatsappThread | `campaignRecipients` | SET_NULL |
| whatsappCampaignRecipient | `message` | whatsappMessage | `campaignRecipient` | SET_NULL |

16 relations → 32 field files. Generate each with `yarn twenty dev:add field` and then replace the
scaffolded literal identifier with `fieldId(...)`.

> **`createdBy` name collision.** Every object already has a platform `createdBy` ACTOR field.
> The campaign's owner relation must therefore be named `owner`, not `createdBy`, or the sync
> will conflict. Use `owner` on `whatsappCampaign` and read the platform `createdBy` ACTOR for
> the audit trail; SEC-12's "acting user" is satisfied by both.

---

## 11. Views shipped with the app

Each view is paired with a navigation menu item or is reachable only from a page layout, per the
CLAUDE.md pitfall note.

| View | Object | Purpose | Surfaced by |
|---|---|---|---|
| All messages | whatsappMessage | Reporting/exports (FR-TL-2) | Admin settings link only |
| Campaigns | whatsappCampaign | Record-list fallback if the Campaigns page fails (C-4) | Nav item `NAV_CAMPAIGNS` shares the page layout; the view is unlisted |
| Templates | whatsappTemplate | Admin publishing gate (FR-TPL-2) | Settings front component |
| Accounts | whatsappAccount | Health at a glance | Settings front component |

`whatsappWebhookEvent`, `whatsappCampaignRecipient` and `whatsappConsentEvent` ship **no** view:
they are high-volume or audit-only and are read through purpose-built UI.

---

## 12. Volume and index rationale (NFR-S1)

At the 50 000 messages/day design point:

| Table | Rows/year | Growth driver | Mitigation |
|---|---|---|---|
| `whatsappMessage` | ~18 M | message volume | `IDX_MESSAGE_THREAD_TS` covers the only hot query (thread page); retention purge (SEC-9) |
| `whatsappWebhookEvent` | ~55 M written, ~1.5 M retained | ≈3 rows per message (inbound + 3 statuses) | 30-day purge is mandatory, not optional |
| `whatsappCampaignRecipient` | campaign-driven | audience sizes | `(campaignId, status)` index keeps claim queries index-only |
| `whatsappThread` | ~100 k | contacts | unique `(accountId, waId)` |

The webhook event table is the real growth risk and the reason `WA_RETENTION_WEBHOOK_EVENT_DAYS`
is a first-class setting with a hard floor of 7 days.
