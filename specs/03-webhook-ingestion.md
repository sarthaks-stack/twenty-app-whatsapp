# 03 — Webhook ingestion

Implements AR-6 … AR-10, AR-15, FR-IN-1 … FR-IN-6, NFR-P1, NFR-P2, NFR-R1, NFR-S2, SEC-2.
Depends on decisions D-1, D-2, D-3, D-4, D-8, D-12.

```
Meta ──POST──► wa-webhook-resolver ──dispatch──► wa-webhook-ingest ──enqueueJob──┬─► wa-inbound-processor ──► wa-media-worker
       GET───► wa-webhook-verify                    (writes raw log)             ├─► wa-status-processor
                                                                                 ├─► wa-template-event
                                                                                 └─► wa-account-event
```

---

## 1. `wa-webhook-verify` — GET handshake

`httpRouteTriggerSettings: { path: '/whatsapp/verify', httpMethod: 'GET', isAuthRequired: false }`
· `timeoutSeconds: 5` · public URL `https://{domain}/s/whatsapp/verify`

```ts
export const handler = async (event: RoutePayload) => {
  const q = event.queryStringParameters;
  const mode = q['hub.mode'];
  const token = q['hub.verify_token'];
  const challenge = q['hub.challenge'];

  metrics.increment('wa.webhook.verify_attempt');

  if (mode !== 'subscribe' || !isNonEmptyString(token) || !isNonEmptyString(challenge)) {
    return new Response('Bad Request', { status: 400 });
  }
  if (!constantTimeEquals(token, requireSecret('META_VERIFY_TOKEN'))) {
    metrics.increment('wa.webhook.verify_rejected');
    logger.warn('verify token mismatch');            // never log either token
    return new Response('Forbidden', { status: 403 });
  }

  await recordVerification();                        // whatsappAccount.webhookLastVerifiedAt = now (all accounts)
  metrics.increment('wa.webhook.verify_ok');
  return new Response(challenge, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
};
```

`constantTimeEquals` wraps `crypto.timingSafeEqual` with a length guard (`timingSafeEqual` throws
on unequal lengths, which itself leaks length — compare SHA-256 digests of both values instead of
the raw strings).

This route exists whether or not probe P-1 succeeds (D-1); it is the deterministic half of the
handshake.

---

## 2. `wa-webhook-resolver` — signature, routing, dispatch

`serverRouteTriggerSettings: { forwardedRequestHeaders: ['x-hub-signature-256'] }`
· `timeoutSeconds: 15` · endpoint `POST /webhooks/server/bb76f114-…`

Runs in the **app-owner workspace**. It performs no record writes and no Meta calls: its only
jobs are authenticity, routing and speed (NFR-P1 < 1 s p95).

```ts
export const handler = async (
  event: RoutePayload<MetaWebhookBody>,
): Promise<ServerRouteResolverResult> => {
  // (a) GET handshake, in case the platform routes GET here (probe P-1)
  if (event.requestContext.http.method === 'GET') {
    return handleVerification(event);                 // same logic as §1
  }

  // (b) raw body must be present — without it we cannot verify and must not process
  if (event.rawBody === undefined) {
    throw new Error('rawBody not forwarded; cannot verify X-Hub-Signature-256');
  }

  // (c) HMAC-SHA256 over the RAW BYTES, before any JSON parsing (SEC-2, AR-6)
  if (!verifyMetaSignature({
        rawBody: event.rawBody,
        header: event.headers['x-hub-signature-256'],
        appSecret: requireSecret('META_APP_SECRET'),
      })) {
    metrics.increment('wa.webhook.signature_rejected');
    return new Response({ error: 'invalid signature' }, { status: 401 });
  }

  const body = event.body;
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
    return new Response({ ok: true, skipped: 'unrecognised payload' }, { status: 200 });
  }

  // (d) resolve the owning workspace (D-3)
  const workspaceId = await resolveWorkspaceId(body);
  if (workspaceId === null) {
    metrics.increment('wa.webhook.unclaimed');
    return new Response({ ok: true, skipped: 'unclaimed number' }, { status: 200 });
  }

  return {
    workspaceId,
    targetLogicFunctionUniversalIdentifier: LF_WEBHOOK_INGEST,
    payload: { body, receivedAt: new Date().toISOString() },
  };
};
```

### 2.1 Signature verification (`src/providers/whatsapp/verify-signature.ts`)

```ts
export const verifyMetaSignature = ({ rawBody, header, appSecret }): boolean => {
  if (!isNonEmptyString(header) || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
};
```

Three properties the tests must pin (12-testing.md):

1. The HMAC is over `rawBody` **as received**, not `JSON.stringify(parsedBody)` — Meta escapes
   non-ASCII as `\uXXXX` and re-serialising changes the bytes. Portuguese accents and emoji make
   this a certainty, not an edge case.
2. Comparison is constant-time over digests of equal length.
3. Any failure returns 401 with zero side effects (no record written, no job enqueued).

### 2.2 Workspace resolution (`resolveWorkspaceId`)

```ts
for (const entry of body.entry) {
  for (const change of entry.changes ?? []) {
    const phoneNumberId = change.value?.metadata?.phone_number_id;
    if (phoneNumberId) {
      const ws = await kv.get<string>(`wa:phone-number:${phoneNumberId}`, { scope: 'SERVER' });
      if (ws) return ws;
    }
  }
  const ws = await kv.get<string>(`wa:waba:${entry.id}`, { scope: 'SERVER' });
  if (ws) return ws;
}
return null;
```

The WABA fallback matters: `message_template_status_update` and `account_update` events carry no
`phone_number_id`.

**Cross-workspace payloads.** A single POST theoretically could contain entries for two WABAs
owned by different workspaces. The resolver can only dispatch to one. Specified behaviour: use
the first resolvable workspace and let `wa-webhook-ingest` drop (and log at `error`, counter
`wa.webhook.foreign_entry`) any change whose `phone_number_id` does not belong to a
`whatsappAccount` in that workspace. In practice Meta scopes a delivery to one app+WABA, so this
is a defensive path, not a routine one — but silently processing another tenant's messages would
be a data-isolation defect, so the check is mandatory.

---

## 3. `wa-webhook-ingest` — raw log and fan-out

Dispatch target, no trigger settings · `timeoutSeconds: 30` · runs in the resolved workspace.

```
for each entry in payload.body.entry:
  for each change in entry.changes:
     1. dedupKey  = buildDedupKey(change)                      # §2 of 02-data-model
     2. account   = findAccountByPhoneNumberId(change.value.metadata?.phone_number_id)
                    ?? findAccountByWabaId(entry.id)
        if none  -> counter wa.webhook.foreign_entry; continue
     3. create whatsappWebhookEvent { dedupKey, field: change.field, payload, processingStatus:'received' }
        on unique violation -> counter wa.webhook.dedup_hit; continue      # D-12
     4. touch account.webhookLastEventAt = now                 # coalesced: at most one write per ingest run
     5. enqueue work items (below)
```

Fan-out rules:

| `change.field` | Work items enqueued |
|---|---|
| `messages` with `value.messages[]` | one `LF_INBOUND_PROCESSOR` job **per message** |
| `messages` with `value.statuses[]` | `LF_STATUS_PROCESSOR` jobs, batched at 50 statuses per job |
| `messages` with `value.errors[]` | `LF_STATUS_PROCESSOR` with `{ kind: 'accountError' }` |
| `message_template_status_update`, `message_template_quality_update`, `message_template_components_update` | `LF_TEMPLATE_EVENT` |
| `account_update`, `phone_number_quality_update`, `account_review_update`, `phone_number_name_update` | `LF_ACCOUNT_EVENT` |
| anything else | mark the event `skipped_duplicate`→ no: mark `processed` with `error: 'unhandled field'`, counter `wa.webhook.unhandled_field` |

All jobs carry `{ webhookEventId, accountId, … }` so a processor can mark the raw row
`processed`/`failed` and so replay (§12.4) re-runs the identical work.

`enqueueJob(..., { retryLimit: 3 })` for processors — the platform's own retry, distinct from
Meta's. A job exhausting retries leaves the raw row `failed` for admin replay (NFR-R1: nothing is
silently dropped).

**Ordering.** Meta guarantees none. One message per job means a `delivered` status can be
processed before the `sent` that precedes it, and even before the outbound record exists. Both
cases are handled in §5, not by trying to order the queue.

---

## 4. `wa-inbound-processor` — one inbound message

`timeoutSeconds: 30`. Input: `{ webhookEventId, accountId, message, contacts, metadata }`.

```
 1. wamid = message.id
 2. if messageExists(wamid) -> counter wa.inbound.dedup_hit; mark processed; return       # AR-8
 3. waId        = message.from
    profileName = contacts?.[0]?.profile?.name
 4. thread = upsertThread(account, waId, profileName)                                     # §5 of doc 05
 5. normalised = normaliseInboundMessage(message)                                         # §4.1
 6. if normalised.kind === 'reaction':
       create whatsappMessage(type:'reaction', reactionTargetWamid, payload)
       patch target message payload.reactions                                             # FR-IN-4
       skip steps 7-9 for preview/unread purposes
 7. create whatsappMessage {
        thread, wamid, direction:'inbound', type, body, payload,
        status:'delivered', statusTimestamps:{ delivered: message.timestamp },
        waTimestamp, contextWamid: message.context?.id, mediaMeta, sourceKind:'system' }
 8. thread updates (single write):
        lastInboundAt = ts; lastMessageAt = ts; lastMessagePreview; lastMessageDirection='inbound';
        unreadCount += 1; status = status === 'closed' ? 'open' : status;                 # FR-THR-2
        serviceWindowExpiresAt = computeWindowExpiry(ts, referral);  windowState='open'   # FR-IN-3
        windowKind, referral (if message.referral present)                                # FR-IN-6
 9. side effects, each independently failure-tolerant:
        a. if media -> enqueueJob(LF_MEDIA_WORKER, { messageId })                          # AR-15
        b. if consent keyword matched -> enqueueJob(LF_CONSENT_KEYWORD, …)                 # FR-CON-3
        c. if thread.originCampaignId and recipient not yet 'responded'
              -> mark recipient responded, increment campaign.respondedCount               # FR-CAM-13
        d. create timelineActivity 'whatsapp.message.received'                              # FR-TL-1
10. mark whatsappWebhookEvent processed
```

Step 9's side effects are enqueued or wrapped in `try/catch` with their own counters: a failure to
write a timeline activity must never lose the message.

### 4.1 Type normalisation (`src/domain/inbound-normalise.ts` — pure, unit-tested)

| Meta `message.type` | Stored `type` | `body` | `payload` |
|---|---|---|---|
| `text` | `text` | `text.body` | `null` |
| `image` / `video` / `document` / `audio` / `sticker` | same | caption (`document.filename` for documents) | `{ mediaId, mime_type, sha256, filename?, voice? }` |
| `location` | `location` | `name ?? address ?? "lat, lng"` | `{ latitude, longitude, name, address }` |
| `contacts` | `contacts` | first contact's formatted name | the raw `contacts[]` array |
| `reaction` | `reaction` | the emoji (`''` when removed) | `{ emoji, messageId }` |
| `interactive.button_reply` | `button_reply` | `title` | `{ id, title }` |
| `interactive.list_reply` | `list_reply` | `title` | `{ id, title, description }` |
| `interactive.nfm_reply` (Flows) | `interactive` | `body` | the raw `nfm_reply` |
| `button` (template quick reply) | `button_reply` | `text` | `{ payload, text }` |
| `order`, `system`, `request_welcome`, unknown | `unsupported` / `system` | `"Unsupported message type: {type}"` | the raw message object |

> **An audio file sent from the device's document picker arrives as `type: document`**, with
> `mime_type: audio/mpeg` and a `.mp3` filename — not `type: audio` (observed 2026-08-15).
> `type: audio` in practice means a voice note (`voice: true`) or forwarded audio media.
>
> Consequence for the UI (08 §3.2): a `document` whose `mediaMeta.mimeType` starts with `audio/`
> must render an audio player, not a bare download link, or reps will be unable to listen to a
> file the customer plainly sent as audio. The same holds for `video/` and `image/` mime types
> arriving as documents.

FR-IN-1's "stored with a placeholder rather than dropped" is the default branch, and the raw
message always lands in `payload` — so an unsupported type is a rendering gap, never data loss.

`message.errors[]` on an inbound message (Meta occasionally reports an undecryptable media) is
stored as `type: 'unsupported'` with `errorCode`/`errorDetail` populated.

---

## 5. `wa-status-processor` — outbound lifecycle

`timeoutSeconds: 30`. Input: `{ webhookEventId, accountId, statuses: MetaStatus[] }` (≤50).

Per status:

```
 1. message = findByWamid(status.id)
 2. if not found:
       # legitimate race: the status webhook beat our own POST response
       if age(status) < 5 min -> re-enqueue this single status with delayMs 5000, retryLimit 5
       else                   -> counter wa.status.orphan; store as orphan on the webhook event; return
 3. next = advanceStatus(message.status, status.status)                # AR-9, pure function
 4. always record statusTimestamps[status.status] = status.timestamp   # even when next === current
 5. if next !== message.status: patch { status: next, statusTimestamps }
 6. if status.status === 'failed':
       patch errorCode/errorDetail from status.errors[0]
       classify(errorCode) -> retryable ? enqueue resend with backoff : terminal
 7. if status.status === 'delivered' and templateCategory is billable:
       billableCostUsd = rateFor(category); accumulate onto campaign.actualCostUsd
 8. if message has a campaignRecipient: mirror the status onto the recipient row and
       increment the campaign counter for that transition                 # FR-CAM-9, FR-CAM-10
 9. conversation/pricing block (status.pricing, status.conversation) stored on payload for audit
```

### 5.0 `read` may never arrive

WhatsApp users can disable read receipts (Settings → Privacy → Read receipts). When they do,
Meta emits `sent` and `delivered` for that contact and **never** emits `read` — silently, with no
error. Confirmed on the project test device on 2026-08-15.

Three consequences that must not be discovered in production:

- **FR-UI-1's blue double-tick may never appear** for such contacts. The UI must treat
  `delivered` as a terminal-looking success state, never render it as a problem, and never imply
  the message was ignored.
- **Campaign `readCount` and read-rate systematically under-report** (FR-CAM-10). The stats panel
  labels the read rate "of contacts with read receipts enabled" rather than presenting it as a
  share of all recipients — otherwise every campaign looks like a failure.
- **Never gate business logic on `read`.** Follow-up timing, engagement scoring and any
  "seen but not answered" rule must key off `delivered` plus inbound activity.
  `whatsappThread.unreadCount` is our own counter for *our* reps and is unaffected.

### 5.1 Status state machine (`src/domain/status-machine.ts`)

```ts
const RANK = { queued: 0, accepted: 1, sent: 2, delivered: 3, read: 4, played: 4 } as const;

export const advanceStatus = (current: Status, incoming: Status): Status => {
  if (current === 'failed') return 'failed';                      // terminal, never resurrected
  if (incoming === 'failed') return RANK[current] >= RANK.delivered ? current : 'failed';
  return RANK[incoming] > RANK[current] ? incoming : current;      // strictly monotonic
};
```

> **Meta's status timestamps are 1-second resolution and collide.** Observed on 2026-08-15:
> three messages produced six status events inside 1.3 s, with a `sent` and two `delivered`
> events for *different* messages all stamped `1786810070`. Ordering statuses by
> `status.timestamp` is therefore impossible even in principle — which is why `advanceStatus`
> ranks the status *values* and never compares times. The timestamps are recorded for audit
> only. (Per-message ordering did hold in this sample, but Meta guarantees nothing, and a single
> well-behaved sample is not evidence that it will.)

Two rules worth stating explicitly because they are easy to get wrong:

- A `failed` arriving **after** `delivered` is ignored for the status field (the message *was*
  delivered) but is still recorded in `statusTimestamps` and `errorDetail`. Meta emits this on
  post-delivery policy actions.
- `read` and `played` share rank 4; `played` (voice notes) does not downgrade `read` and
  vice-versa, and whichever arrives first wins the field while both are timestamped.

### 5.2 Counter coalescing (NFR-R2)

At campaign scale, one status write per recipient plus one increment per campaign counter would
exceed the Core API budget. Therefore:

- Recipient rows are updated in **batches of ≤60** within a single status job.
- Campaign counters are **not** incremented per status. `wa-status-processor` writes deltas to
  `kv` (`wa:campaign-delta:{campaignId}`), and `wa-stats-rollup` (cron, every 30 s) folds them
  into the campaign record in one write. This meets FR-CAM's "live stats ≤ 30 s p95" target
  (§3.2) while costing one write per campaign per tick instead of one per message.

---

## 6. `wa-template-event`

`timeoutSeconds: 15`. Handles `message_template_status_update`,
`message_template_quality_update` and `message_template_components_update` (AR-10, FR-TPL-1).

```
find template by (account, metaTemplateId = value.message_template_id)
  ├─ not found -> enqueue a full LF_TEMPLATE_SYNC for that account and finish
  └─ found     -> patch status / rejectedReason / qualityScore / category
                  if new category !== old: previousCategory = old; notify admins
                  if status becomes rejected|disabled|paused: publishedToCrm = false   # fail closed
                  if qualityScore becomes red: publishedToCrm = false, admin alert     # R-5
                  if components changed: re-derive variableSpec + assessSupport, and if the
                    placeholder count changed, unpublish and alert — every existing variable
                    mapping is now wrong (132000/132012 for every recipient)
```

Un-publishing on degradation is deliberate: FR-TPL-2 gates reps on `publishedToCrm`, so revoking
it is the fastest containment for a template Meta has turned against.

Any campaign currently using a template that becomes non-approved is paused with
`statusReason = 'template_unavailable'` (interacts with AR-22).

---

## 7. `wa-account-event`

`timeoutSeconds: 15`. Handles `account_update`, `phone_number_quality_update`,
`account_review_update`, `phone_number_name_update` (FR-ACC-3).

```
phone_number_quality_update -> qualityRating; messagingLimitTier if present
account_update              -> ban/restriction info -> status='error' + statusDetail; display name review
account_review_update       -> statusDetail
phone_number_name_update    -> displayName
```

Consequences wired here rather than in the UI:

- `qualityRating` → `red`: all `running` campaigns on that account are paused with
  `statusReason = 'quality_red'` (AR-22, FR-CAM-11), and launching a new one is blocked
  (FR-CAM-6). 1:1 messaging is **not** blocked — reps must still be able to answer customers.
- `qualityRating` → `yellow`: campaigns keep running; the inbox and builder show a warning banner
  (FR-UI-6).
- Account restricted/banned → `status = 'error'`, all sends paused, admin alert with the Business
  Support Home link (appendix B, codes 368 / 131031).

---

## 8. `wa-media-worker`

`timeoutSeconds: 120`. Input `{ messageId, force?: boolean }`. Implements AR-15, AR-16, D-8.

```
 1. message = load(messageId); meta = message.mediaMeta
 2. if meta.fileSize > WA_MEDIA_AUTO_DOWNLOAD_MAX_BYTES and !force:
        patch mediaMeta.deferred = true; return                      # D-8
 3. url = meta.inlineUrl (if present and not expired)                # see note below
       ?? provider.fetchMediaUrl(meta.mediaId).url
 4. buffer = provider.downloadMedia(url)                              # Bearer token required
        on 404/410 -> refetch url once (URLs live ~5 min, ids live 7 days) then retry
 5. verify sha256 and size; reject mismatch (counter wa.media.integrity_fail)
 6. file = metadataClient.uploadFile(buffer, filename, mimeType, WA_MESSAGE_MEDIA_FILE_FIELD_ID)
 7. patch message.mediaFile = [file]; mediaMeta.downloadFailed = false
```

Failure handling: increment `mediaMeta.downloadAttempts`; re-enqueue with exponential backoff
(2 s, 8 s, 32 s, 128 s) up to 4 attempts; then set `mediaMeta.downloadFailed = true`. The UI
renders a "Retry download" affordance that calls the worker with `force: true` — meaningful for
7 days, after which the copy changes to "Media expired on Meta's servers" (§11.3).

> **Real deliveries inline the media URL.** Confirmed by capture on 2026-08-15: an inbound
> voice note arrived with `audio.url` already populated —
> `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=…&ext=…&hash=…` — carrying its
> own expiry (`ext`, ~10 minutes observed). Meta's documentation describes only the
> `GET /{media_id}` resolution step, so the spec originally assumed a mandatory round-trip.
>
> The worker therefore uses the inlined URL when it is present and the job is running promptly,
> and falls back to `GET /{media_id}` otherwise. The fallback is not optional: the inline URL
> expires far sooner than the 7-day media id, so every retry, every deferred download (D-8) and
> every replayed webhook must re-resolve. The inlined URL is stored in `mediaMeta.inlineUrl`
> alongside `mediaMeta.inlineUrlExpiresAt` derived from `ext`.
>
> The URL also carries a `hash` access token, which is why capture strips it before a fixture is
> committed.

`filename` for storage is `{wamid}.{ext}` derived from the mime type, never the sender-supplied
filename (path-traversal hygiene); the original filename is preserved in `mediaMeta.filename` and
shown in the UI.

---

## 9. Performance and burst behaviour

| Target | Mechanism |
|---|---|
| NFR-P1 — ack < 1 s p95 | Resolver does 1 HMAC + ≤2 kv reads and returns; no record I/O, no Meta I/O |
| NFR-P2 — visible ≤ 5 s p95 | ingest (≤300 ms) + processor (≤1 s) + poll interval (3 s focused) |
| NFR-S2 — 50 deliveries/s for 60 s | The platform queue absorbs the burst; ingest is O(changes) with one write each; processors scale independently. Load test replays recorded fixtures at 50/s (12-testing.md) |
| NFR-R1 — no silent drops | Every change becomes a `whatsappWebhookEvent` row before processing; processor failure leaves `processingStatus='failed'` with the error, replayable from the settings UI |

---

## 10. Metrics emitted (NFR-O2)

`wa.webhook.{verify_attempt,verify_ok,verify_rejected,signature_rejected,unclaimed,foreign_entry,dedup_hit,unhandled_field}`,
`wa.inbound.{processed,dedup_hit,unsupported_type,auto_created_person,needs_review}`,
`wa.status.{processed,orphan,downgrade_ignored,failed_terminal,failed_retryable}`,
`wa.media.{downloaded,deferred,retry,integrity_fail,failed}`,
`wa.template.{event,unpublished_on_degradation}`,
`wa.account.{quality_change,restricted}`.

Counters are `kv`-backed with WORKSPACE scope, keyed `wa:metric:{name}:{yyyy-mm-dd}`, and
surfaced in the settings health panel (NFR-O3). They are approximate by construction (no CAS) and
are documented as such — they exist for trend detection and alerting, not billing.
