# 00 — Architecture decisions & TRD deltas

Each decision below is binding for implementation. Decisions marked **Δ TRD** amend the TRD;
the amendment text is what should be folded back into TRD v1.2.

---

## D-1 — The Meta callback URL is platform-assigned, not author-chosen

**Status: SPECIFIED (with a PROBE on the GET handshake)** · Δ TRD §5.1, AR-6, §12.1, §12.2

The TRD specifies the callback path as `https://{domain}/s/whatsapp/webhook`. That path shape
belongs to `httpRouteTriggerSettings`. `ServerRouteTriggerSettings` accepts **only**
`forwardedRequestHeaders` — the endpoint is derived from the resolver's universal identifier:

```
POST https://{domain}/webhooks/server/bb76f114-7843-4a09-af64-9ceca78479cd
```

Because `LF_WEBHOOK_RESOLVER` is a compile-time constant (appendix C), the URL is stable and
known at build time. The settings UI (§FR-ACC-2) renders it by concatenating
`window.location.origin` with `/webhooks/server/` + the constant, with a copy button.

### The GET handshake problem

Meta verifies a callback by issuing `GET {callback_url}?hub.mode=subscribe&hub.challenge=…&hub.verify_token=…`
and requires the response body to be **the bare challenge string** (`text/plain`, no JSON
quoting). Two unknowns:

1. Does the server-route endpoint accept `GET` at all? The documentation describes it as `POST`.
2. If it does, is a `Response` body returned verbatim or JSON-encoded? A JSON-encoded body
   (`"1158201444"`) fails Meta's verification.

**Probe P-1** (week 1) answers both. Two specified outcomes:

- **P-1 pass** — single URL, nothing further needed. `wa-webhook-resolver` handles `GET` by
  reading `event.queryStringParameters['hub.verify_token']`, comparing against
  `META_VERIFY_TOKEN` with `timingSafeEqual`, and returning
  `new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } })`.
- **P-1 fail** — the reverse proxy in front of Twenty owns one public path and method-splits it:

  ```caddy
  @wa_verify   method GET
  @wa_events   method POST
  handle /whatsapp/webhook {
      reverse_proxy @wa_verify twenty:3000 {
          rewrite /s/whatsapp/verify{uri.query}          # httpRouteTriggerSettings, isAuthRequired:false
      }
      reverse_proxy @wa_events twenty:3000 {
          rewrite /webhooks/server/bb76f114-7843-4a09-af64-9ceca78479cd
      }
  }
  ```

  Meta is then configured with `https://{domain}/whatsapp/webhook`. Full Caddy and Nginx
  snippets: [11-observability-operations.md § Reverse proxy](11-observability-operations.md#reverse-proxy-configuration).
  The verification-only HTTP route (`LF_WEBHOOK_VERIFY`, `/s/whatsapp/verify`,
  `isAuthRequired: false`) is implemented **unconditionally** — it costs ~30 lines and removes
  the probe from the critical path.

**Never** point Meta directly at `/webhooks/server/{uuid}` in production docs without also
documenting the proxy alias: rotating the resolver's UUID would silently break ingestion.

---

## D-2 — One webhook POST fans out inside the workspace, not at the resolver

**Status: SPECIFIED** · Δ TRD AR-7

The TRD has the resolver "dispatching to the appropriate processor function
(`wa-inbound-processor` for `value.messages[]`, `wa-status-processor` for `value.statuses[]`)".
A resolver can name exactly **one** target function per request, and a single Meta POST routinely
carries several `entry[]` elements, each with several `changes[]`, and a single `messages`
change carries `messages[]` *and* `statuses[]` *and* `errors[]` simultaneously.

Pipeline:

```
Meta POST
  └─ wa-webhook-resolver        (owner workspace; HMAC verify; resolve workspaceId)
        └─ returns { workspaceId, target: LF_WEBHOOK_INGEST, payload: rawBodyEnvelope }
              → platform answers 202 {queued:true}
        └─ wa-webhook-ingest    (target workspace)
              1. explode entry[]/changes[] → one whatsappWebhookEvent row per change
              2. enqueueJob per work item:
                   value.messages[]  → LF_INBOUND_PROCESSOR   (one job per message)
                   value.statuses[]  → LF_STATUS_PROCESSOR    (one job per status batch of ≤50)
                   message_template_* → LF_TEMPLATE_EVENT
                   account_update / phone_number_quality_update → LF_ACCOUNT_EVENT
```

`wa-webhook-ingest` performs no Meta I/O and no matching logic — it is a pure fan-out so that a
poison payload cannot stall the queue. Its `timeoutSeconds` is 15.

---

## D-3 — Workspace routing uses a SERVER-scoped kv claim keyed by phone number **and** WABA

**Status: SPECIFIED** · New (TRD is silent)

The resolver runs in the app-owner workspace and must produce a `workspaceId`. Mirroring the
Slack app's `slack-team:{team_id}` pattern:

| Key (scope `SERVER`) | Value | Written by | Cleared by |
|---|---|---|---|
| `wa:phone-number:{phone_number_id}` | `workspaceId` | `wa-account-admin-route` on successful connect | disconnect action, `wa-uninstall` |
| `wa:waba:{waba_id}` | `workspaceId` | same | same |

Resolution order in the resolver:

1. `entry[].changes[].value.metadata.phone_number_id` → `wa:phone-number:…`
2. fall back to `entry[].id` (the WABA id, present on template/account events) → `wa:waba:…`
3. no claim → return `new Response({ ok: true, skipped: 'unclaimed' })` **with 200**, so Meta
   stops retrying an event nobody owns. Increment a counter and log at `warn`.

This is required even in the single-workspace self-hosted deployment (A-1): the resolver has no
implicit "the only workspace" handle.

Multi-account (FR-ACC-6) works naturally — each `phone_number_id` writes its own claim.

---

## D-4 — "Persist before ack" is not achievable as written; compensating controls specified

**Status: SPECIFIED (accepted deviation)** · Δ TRD AR-7, NFR-R1

AR-7 requires the raw payload to be persisted **before** returning 200. On this platform the
resolver returns a dispatch instruction and the platform immediately answers `202`; the raw event
row is written by `wa-webhook-ingest` a moment later, in the target workspace. There is no hook
between "verified" and "acked" where a workspace-scoped record can be written.

Accepted, with these compensating controls:

1. `wa-webhook-ingest` writes all `whatsappWebhookEvent` rows **before** enqueueing any
   processing job. The durability gap is therefore only the platform's own dispatch queue, not
   our business logic.
2. Meta retries an unacknowledged or 5xx-answered delivery for up to 7 days. The resolver
   throws (→ non-2xx) on any failure it cannot classify, so Meta keeps retrying.
3. `wa-health-check` (hourly) alerts when `whatsappAccount.webhookLastEventAt` exceeds a
   configurable staleness threshold, catching a silently broken pipeline.
4. `wa-reconcile` behaviour is folded into `wa-health-check`: for every `whatsappMessage` in a
   non-terminal status older than 15 minutes, re-derive status where the API allows and
   otherwise mark `failed` with `errorCode = 'INTERNAL_TIMEOUT'` (NFR-R3).

**TRD amendment text for AR-7:** *"The resolver SHALL verify the signature and return a dispatch
result within 1 s. The dispatched ingest function SHALL persist the raw payload as
`whatsappWebhookEvent` records before performing any further processing."*

---

## D-5 — Pacing is deterministic scheduling, not a contended token bucket

**Status: SPECIFIED** · Δ TRD AR-12, AR-19

`kv` exposes `get`/`set`/`delete` with no compare-and-swap. A token bucket in `kv` read-modify-
written by N concurrent senders will lose updates and either over-send (risking Meta 130429) or
deadlock.

Instead, pacing is assigned **at enqueue time by a single writer**:

- Each `whatsappAccount` carries two cursor fields: `interactiveCursorAt` and `campaignCursorAt`
  (`DATE_TIME`).
- The enqueuing function (`wa-send-message-route` for 1:1, `wa-campaign-runner` for bulk) reads
  its cursor, computes a slot for each message —
  `slot_i = max(now, cursor) + i * (1000 / laneRate) ms` — writes the new cursor back, and calls
  `enqueueJob(LF_OUTBOUND_SENDER, { messageId }, { delayMs: slot_i - now, retryLimit: 0 })`.
- Retries are re-enqueued by the sender itself with its own backoff (`delayMs`), so a retry never
  jumps the queue.

**Lane rates** implement the AR-19 priority split without a priority queue:

| Lane | Default rate | Rule |
|---|---|---|
| interactive (rep-typed, workflow 1:1, template send from a thread) | `sendThrottlePerSecond × 0.4`, minimum 5/s | never blocked by campaign traffic |
| campaign | `sendThrottlePerSecond × 0.6` | paused/slowed by guardrails |

`sendThrottlePerSecond` defaults to 20 (well under Meta's 80/s). The lanes are independent
cursors, so a saturated campaign lane cannot delay an interactive send — satisfying NFR-S5
structurally rather than by best effort.

Per-recipient spacing against error 131056 is enforced separately: `wa-outbound-sender` refuses
to send if the thread's `lastOutboundAt` is under 250 ms old and re-enqueues itself with
`delayMs: 250`.

Concurrency caveat: two *interactive* sends racing on the same cursor can lose one update. That
costs at most one extra message in a second — acceptable at a 40 %-of-ceiling lane rate. The
campaign lane has exactly one writer (the cron runner) and is therefore exact.

---

## D-6 — Front-end freshness is an aggregated polling endpoint with an explicit request budget

**Status: SPECIFIED** · Δ TRD FR-UI-4, NFR-R2, C-1

Naïve 5 s polling from every open surface breaks the 100 req/min API budget:
25 reps × 12 req/min × (thread + inbox) = 600 req/min.

Design:

- **One** app HTTP route serves all UI freshness needs:
  `GET /s/whatsapp/feed?scope=thread|inbox|campaign&id=…&since=<ISO8601>` (`LF_INBOX_FEED_ROUTE`).
  It returns only deltas since the cursor, and the components hold everything else in React state.
- Requests to app HTTP routes are authenticated with `TWENTY_APP_ACCESS_TOKEN`, and the route's
  own reads of workspace records happen server-side in one batched query — so one UI poll costs
  one inbound request plus a bounded number of internal reads, instead of N Core API reads
  from the browser.
- **Adaptive intervals**, configured by `WA_POLL_INTERVAL_*` application variables:

  | Surface state | Interval |
  |---|---|
  | Chat panel, thread open, window focused | 3 s |
  | Chat panel, window blurred | 20 s |
  | Inbox list, focused | 8 s |
  | Campaign stats, running campaign | 10 s |
  | Any surface, 15 min without user interaction | poll suspended; a "Reconnect" chip resumes it |

  Worst realistic case: 25 reps × 20 req/min = 500 req/min against the app route. This still
  exceeds a 100 req/min budget **if that limit applies to app HTTP routes**. → **Probe P-2** must
  measure the limit that actually applies to `/s/*` routes on the target version (Q-5).
  Fallback if the limit binds: raise the focused interval to 10 s, and gate on the
  self-hosted instance's configurable rate-limit env var (R-7).
- Overlap guard: the sandbox drops `AbortSignal`, so each component keeps an `inFlight` ref and
  skips a tick rather than stacking requests.
- Optimistic rendering on send masks the interval for the action that matters most (FR-OUT-1).

---

## D-7 — Chat scrolling must be CSS-driven; the sandbox cannot scroll programmatically

**Status: SPECIFIED** · Δ TRD FR-UI-1, C-3, R-3

In the front-component sandbox, assigning `scrollTop`/`scrollLeft` is a documented **no-op**, and
`IntersectionObserver` throws. A conventional chat implementation ("append message, scroll to
bottom", "observe sentinel to load more") is therefore impossible.

Specified implementation:

- The message list is a `display:flex; flex-direction: column-reverse; overflow-y: auto`
  container fed the message array **newest-first**. The browser anchors a column-reverse
  scroller at the bottom, so new messages appear pinned to the bottom with no scripted scroll,
  and the user's scroll position is preserved when older messages are prepended (visually
  appended).
- Older pages load from an explicit **"Load older messages"** button rendered at the visual top
  (array end), plus an `onScroll` handler that auto-triggers the same action when
  `scrollTop` (read is allowed) approaches the extent. No observers.
- Day separators are computed during render, not injected by measurement.
- The composer is a controlled `<textarea>`; focus cannot be set programmatically
  (`.focus()` throws), so the panel must not rely on autofocus. Keyboard send is
  `onKeyDown` (Enter = send, Shift+Enter = newline).

---

## D-8 — Inbound media is downloaded selectively, with a size ceiling below Meta's

**Status: SPECIFIED** · Δ TRD AR-15, AR-16

Meta allows documents up to 100 MB. Buffering 100 MB in a logic function and re-uploading it
through `MetadataApiClient.uploadFile` is a memory and timeout hazard at unknown platform limits
(Q-5). Specified behaviour:

- `WA_MEDIA_AUTO_DOWNLOAD_MAX_BYTES` (application variable, default **26_214_400** = 25 MB).
- Media at or under the ceiling: downloaded by `wa-media-worker` and stored in the message's
  `mediaFile` FILES field.
- Media above the ceiling: **not** downloaded. `mediaMeta.deferred = true` is stored with the
  `media_id`, mime and size, and the UI shows a "Download (18 MB)" action that invokes
  `wa-media-worker` on demand. Media IDs stay valid for 7 days, so the affordance is real, and
  it degrades to "expired — ask the contact to resend" after that.
- Outbound media keeps Meta's own caps as hard validation (AR-16) and always sends by
  `media_id` (AR-14), never by link.

---

## D-9 — Timeline activities are written directly to the standard `timelineActivity` object

**Status: SPECIFIED (PROBE on app write permission)** · Δ TRD FR-TL-1

`timelineActivity` is a standard object exposing `name`, `happensAt`, `properties` (JSON),
`targetPerson`, `targetCompany`, `linkedRecordId`, `linkedObjectMetadataId` and
`linkedRecordCachedName`. WhatsApp events are written as records on it — see
[09-workflows-timeline-notifications.md](09-workflows-timeline-notifications.md) for the event
name catalog and payload shapes.

**Probe P-3**: confirm an app role can create `timelineActivity` records (it may be
engine-owned/read-only). Fallback if not writable: rely on Twenty's automatic timeline entries
for the linked `whatsappMessage` records and surface history through the WhatsApp tab only,
downgrading FR-TL-1 to SHOULD with stakeholder sign-off.

---

## D-10 — There is no notification API; FR-IN-5's "in-app notification" is re-specified

**Status: OPEN → recommendation SPECIFIED** · Δ TRD FR-IN-5

The full standard-object surface contains no notification entity, and the front-component host
API offers only `enqueueSnackbar` (which requires a mounted component). A true in-app
notification to an offline assignee is not achievable inside the app boundary.

Re-specified as three layers, delivered together:

1. **Unread state** — `whatsappThread.unreadCount` and an inbox filter; the WhatsApp Inbox page
   shows per-thread unread badges (FR-UI-2/FR-UI-6). This is the primary signal.
2. **Live toast** — a headless front component (`isHeadless: true`) mounted on the Inbox page
   polls the feed route and calls `enqueueSnackbar` for new inbound messages assigned to the
   current user. Only fires while a Twenty tab is open on that page.
3. **Escalation via workflow** — `whatsappMessage.created` is a database-event trigger
   (FR-WF-2), so operators can wire "create a Task for the assignee" or "post to Slack" using
   the first-party Slack app. This is the only channel that reaches an offline rep, and it is
   configuration, not code.

Desktop/push notifications (FR-UI-7, MAY) remain out of scope.

**TRD amendment for FR-IN-5:** replace *"an in-app notification to the thread assignee"* with
*"an unread indicator on the thread and inbox for the assignee, a live toast while the Inbox is
open, and a `whatsappMessage.created` database event that operators may route to Tasks or Slack."*

---

## D-11 — Relations are separate two-sided field files; scalar fields are inline

**Status: SPECIFIED** · New

`defineObject` accepts inline field manifests, but a `RELATION` needs its counterpart field's
universal identifier on the other object, which creates a circular import if both live inside
their object files. Following the postcard example, the convention is:

- Scalar/composite fields (`TEXT`, `SELECT`, `DATE_TIME`, `RAW_JSON`, `FILES`, `NUMBER`,
  `BOOLEAN`) are declared **inline** in `src/objects/<name>.object.ts`.
- Every relation is **two files** in `src/fields/`, one per side, each exporting its own
  identifier constant and importing the other's:
  `<field>-on-<object>.field.ts`.
- Field universal identifiers are **derived**, never hand-generated, via
  `getFieldUniversalIdentifier({ applicationUniversalIdentifier, objectUniversalIdentifier, name })`
  (a deterministic UUID v5). Only object/function/component/layout/role/index identifiers are
  hand-assigned v4 UUIDs (appendix C). This keeps the registry to ~55 entries instead of ~200 and
  removes an entire class of copy-paste bug.

---

## D-12 — Idempotency is enforced by unique constraints and treats conflict as success

**Status: SPECIFIED** · Δ TRD AR-8

- `whatsappMessage.wamid` — `isUnique: true` + unique index `IDX_MESSAGE_WAMID`.
- `whatsappWebhookEvent.dedupKey` — `isUnique: true` + unique index.
- `whatsappCampaignRecipient` — unique index on (`campaign`, `person`).
- `whatsappThread` — unique index on (`account`, `waId`).

All writers use *create-and-catch*, not *check-then-create*: a uniqueness violation is caught,
counted as `dedup_hit`, and returns success. Read-then-write loses to concurrent duplicate
webhook delivery, which Meta explicitly permits.

Soft-delete interaction is a **PROBE (P-4)**: if a soft-deleted row still occupies the unique
index, a purged-then-replayed message cannot be re-created. Fallback: the retention purge
(SEC-9) hard-destroys rather than soft-deletes `whatsappMessage`, and the ingest treats an
"already exists but deleted" conflict as `skipped_duplicate`.

---

## D-13 — Twenty now ships `messageCampaign`/`messageList`; we still own our objects

**Status: SPECIFIED (decision recorded)** · Δ TRD §2.1

Since the TRD's platform survey, `messageCampaign`, `messageList` and `messageListMember` have
appeared as standard objects, and `person` carries `listMemberships`. They are email-shaped
(`fromAddress`, `subject`, `bodyTemplate`, `unsubscribeTopicId`, bounce/complaint counters) and
`timelineActivity` even has a `targetMessageCampaign`.

Decision: **keep app-owned `whatsappCampaign`/`whatsappCampaignRecipient`.** WhatsApp campaign
state (tier budget, per-recipient Meta error codes, template parameter snapshots, `tier_waiting`)
has no home in the email model, and coupling to a young standard object contradicts the TRD's
§2.4 rationale.

Two concessions that cost little and pay off if the models converge:

- Campaign **audience selection** accepts a `messageList` as an audience source alongside a
  Twenty view and manual selection (FR-CAM-2 extension) — reusing the platform's list-building UX
  where it already exists.
- `whatsappCampaign` mirrors `messageCampaign`'s counter naming (`sentCount`, `failedCount`, …)
  so a future migration is a projection, not a redesign.

---

## D-14 — Provider seam is a plain module boundary, not an injected interface

**Status: SPECIFIED** · Refines AR-18

`src/providers/whatsapp/` exports a `WhatsAppProvider` type and one implementation,
`cloudApiProvider`, selected by a single `getProvider()` factory reading
`WA_PROVIDER` (application variable, default `cloud-api`). Logic functions import
`getProvider()`, never `fetch` against `graph.facebook.com` directly — enforced by an oxlint
rule banning the literal `graph.facebook.com` outside `src/providers/`.

Interface (exact signatures in [appendix-a-meta-api.md](appendix-a-meta-api.md)):

```ts
type WhatsAppProvider = {
  sendMessage(input: SendMessageInput): Promise<SendResult>;
  uploadMedia(input: UploadMediaInput): Promise<{ mediaId: string }>;
  fetchMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string; fileSize: number; sha256: string }>;
  downloadMedia(url: string): Promise<{ buffer: Buffer; mimeType: string }>;
  listTemplates(wabaId: string, cursor?: string): Promise<{ templates: MetaTemplate[]; nextCursor?: string }>;
  createTemplate(wabaId: string, definition: MetaTemplateDefinition): Promise<{ id: string; status: string }>;
  getPhoneNumber(phoneNumberId: string): Promise<MetaPhoneNumber>;
  markAsRead(phoneNumberId: string, wamid: string): Promise<void>;
  verifyWebhookSignature(rawBody: string, header: string | undefined): boolean;
  parseWebhook(body: unknown): NormalisedWebhookEvent[];
};
```

---

## Decision summary

| ID | Decision | TRD impact |
|---|---|---|
| D-1 | Callback URL is `/webhooks/server/{resolverUUID}`; proxy alias + GET-verify route | Amend §5.1, AR-6, §12 |
| D-2 | Resolver → single ingest function → internal fan-out | Amend AR-7 |
| D-3 | SERVER-scoped kv claims key routing by `phone_number_id` and `waba_id` | New |
| D-4 | Persist-before-ack relaxed; compensating controls | Amend AR-7, NFR-R1 |
| D-5 | Deterministic `delayMs` scheduling with interactive/campaign lanes | Amend AR-12, AR-19 |
| D-6 | Single aggregated feed route + adaptive polling + measured budget | Amend FR-UI-4 |
| D-7 | `column-reverse` chat, explicit "load older"; no programmatic scroll | Amend FR-UI-1, R-3 |
| D-8 | 25 MB inbound auto-download ceiling, deferred download above it | Amend AR-15 |
| D-9 | Direct `timelineActivity` writes | Confirms FR-TL-1, probe |
| D-10 | No notification API — unread + toast + workflow escalation | Amend FR-IN-5 |
| D-11 | Two-sided relation files; derived field UUIDs | New convention |
| D-12 | Unique constraints + create-and-catch | Refines AR-8 |
| D-13 | Keep app-owned campaign objects; accept `messageList` as audience source | Amend §2.1, FR-CAM-2 |
| D-14 | Provider module + lint-enforced boundary | Refines AR-18 |


---

## D-15 — Runtime code never depends on `twenty-sdk/define` values

**Status: SPECIFIED (forced by the platform)** · Discovered 2026-08-15 during phase 5 verification

The logic-function bundler replaces every value imported from `twenty-sdk/define` with
`__anyStub`. That module builds the *manifest*; it is not a runtime library. So a derived
constant like

```ts
export const MESSAGE_MEDIA_FILE = fieldId(OBJ_MESSAGE, 'mediaFile');   // getFieldUniversalIdentifier
```

evaluates to nothing inside a running function.

**Nothing warns.** The type checker still sees a `string`, `dev:build` succeeds, `plan` and
`apply` are clean, and the first real call fails with
`Variable "$fieldMetadataUniversalIdentifier" of required type "String!" was not provided` — a
message naming neither the constant nor the cause. The bundle is the only place the truth is
visible (`var getFieldUniversalIdentifier = __anyStub;`).

Consequences:

1. The `define*` factories remain fine to import: their return value is read at build time and
   never at runtime, so the stub is harmless.
2. Everything else — `getFieldUniversalIdentifier`, `STANDARD_OBJECT`, `FieldType` — is banned
   from `src/logic-functions/**` and `src/server/**`, enforced by `architecture.test.ts`.
3. Metadata identifiers a function needs at runtime are **asked of the server** and cached
   (`src/server/metadata-ids.ts`). The server is the better authority anyway: it holds whatever
   the last apply actually created.

Plain string literals (`OBJ_*`, `LF_*`, `ROLE_*`) are unaffected — they are literals, not
derived values, and survive bundling intact.

---

## D-16 — File uploads go through the **metadata** client

**Status: SPECIFIED (forced by the platform)** · Discovered 2026-08-15

`uploadFile` exists as a method on both `CoreApiClient` and `MetadataApiClient`, but
`uploadFilesFieldFileByUniversalIdentifier` is implemented only on the **metadata** endpoint.
Calling it through the core client fails with `Unknown type "Upload". Did you mean "Float"?`.

A method existing on a client is not evidence that its endpoint serves the mutation. The original
spec said `MetadataApiClient.uploadFile` and was right.

---

## D-17 — A changed application-variable declaration does not overwrite a saved value

**Status: OBSERVED** · 2026-08-15

An `applicationVariable` already stored in a workspace is a *user setting*. Editing its declared
`value` and re-applying changes the default for fresh installs and leaves every existing install
on the old value — correct behaviour, and a trap when the value is also a lookup key.

It bit `WA_PROVIDER`, declared `cloud-api` while the provider registry knew `META_CLOUD_API`.
Everything typechecked, every unit test passed, the app applied cleanly, and the first live
connect failed with `Unknown WA_PROVIDER "CLOUD-API"`. Two fixes, both needed:

- the declaration now matches the registry key, `UPPER_SNAKE_CASE` like every other SELECT;
- `getProvider` canonicalises separators and carries an explicit alias for the previously shipped
  value, because re-applying cannot migrate a setting an operator may have saved. An alias is not
  a fallback: an unrecognised provider still throws.

A test compares the declared options against the registry so the two cannot drift again.

---

## D-18 — One HTTP exception outside the provider, narrowed by an origin guard

**Status: DECIDED** · 2026-08-16

AR-11 confines every outbound HTTP call to `src/providers/whatsapp`, and the rule is enforced by
an architecture test rather than a lint rule because it needs to fail the build. Outbound media
forces exactly one exception: an attachment's bytes live in Twenty's own storage, and something
has to read them before they can be uploaded to Meta.

`RestApiClient` from the SDK cannot do it — it reads every response with `response.text()`, which
corrupts binary content silently rather than failing. So `src/server/files.ts` calls `fetch`, and
is the only module outside the provider that may.

What keeps that an exception rather than a hole:

- `resolveFileUrl` compares `URL.origin` against `TWENTY_API_URL` and throws otherwise, so the
  function cannot be handed Meta's media CDN URL — which arrives *inside* a webhook payload and is
  precisely the second path to Meta that AR-11 exists to prevent;
- the comparison is on `origin`, never a string prefix, because `startsWith` passes for
  `https://crm.example.com.attacker.test/`;
- the architecture test asserts both the exception list and the presence of the guard, so removing
  the check fails the build rather than quietly widening the rule.

---

## D-19 — Repository finders never use Twenty's singular record query

**Status: OBSERVED** · 2026-08-16

`whatsappThread(filter: { id: { eq: … } })` does not answer `null` for a record that is not there.
It answers `null` **and** a GraphQL error, `RECORD_NOT_FOUND`, which the genql client raises.

So a finder written the obvious way — the one an editor's autocomplete offers first — throws where
its signature promises `null`. Every caller's not-found branch becomes unreachable: a route that
should answer `404 Unknown thread` answers `500 Internal error`, and inside a queued job a deleted
record becomes a lost job rather than a handled skip.

It typechecks, and it passes every unit test, because the defect is in the server's response and
not in our code's shape. It was found by asking a live route for a thread id that does not exist.

Every finder now uses the plural query with an id filter and `first: 1`, which answers an empty
connection. An architecture test bans the singular form in `src/server/repositories`.
