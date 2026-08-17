# 11 — Observability and operations

Implements NFR-O1 … NFR-O3, NFR-R1 … NFR-R4, FR-ACC-2, FR-ACC-4, TRD §12.

---

## 1. Structured logging (NFR-O1)

`src/server/logger.ts` is the only module allowed to write to the console (lint-enforced).

```ts
logger.info('inbound.processed', { correlationId, threadId, messageType, durationMs });
```

Every line carries:

| Field | Value |
|---|---|
| `ts` | ISO-8601 |
| `level` | `debug` · `info` · `warn` · `error`, gated by `WA_LOG_LEVEL` (default `info`) |
| `event` | dotted event name matching the metric names |
| `correlationId` | **WAMID** where one exists, otherwise the `dedupKey`, otherwise the campaign or message id |
| `fn` | logic function name |
| `accountId`, `threadId`, `campaignId` | when known |
| `durationMs` | for anything that calls Meta or the Core API |

The correlation id is the whole point: given a customer complaint ("she never got the message"),
one WAMID grep across `yarn twenty dev:function:logs` output reconstructs resolver → ingest →
processor → sender → status.

Every payload passes through the redactor (10 §1) before serialisation. There is no
"log the raw request" debug switch — the raw payload is already in
`whatsappWebhookEvent.payload`, which is access-controlled, whereas logs are not.

---

## 2. Metrics (NFR-O2)

`kv`-backed counters, WORKSPACE scope, keyed `wa:metric:{event}:{yyyy-mm-dd}`, 90-day retention.
The full emitted set is listed in [03 §10](03-webhook-ingestion.md#10-metrics-emitted-nfr-o2) plus:

`wa.send.{scheduled,accepted,retry,failed_terminal,skip_nonqueued,unmapped_error,unknown_acceptance}`,
`wa.policy.{denied_window,denied_consent,denied_template,denied_quality}`,
`wa.api.{core_call,core_429,core_error}`,
`wa.campaign.{claimed,queued,paused_breaker,paused_quality,tier_waiting}`,
`wa.feed.{request,skipped_overlap}`.

They are approximate (no compare-and-swap on `kv`) and documented as such: they exist for trend
detection and alerting, not for billing or for the campaign counters, which are derived from
records.

---

## 3. Health panel and alerting (NFR-O3, FR-ACC-4)

`wa-health-check` — `cronTriggerSettings: { pattern: '0 * * * *' }`, `timeoutSeconds: 60`.

Per account, in order:

1. `GET /{phone_number_id}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,throughput`
   → refresh the record; on `190`/`100` set `status = 'error'` with `statusDetail`, pause sends,
   alert (R-8). On success set `tokenLastCheckedAt`.
2. Webhook liveness: `webhookLastEventAt` older than `WA_WEBHOOK_STALENESS_HOURS` (default 24,
   and only alerting if the account has ever received an event) → warn.
3. Tier window: roll `tierWindowStartedAt` past 24 h, reset `tierUniqueUsersUsed`, wake
   `tier_waiting` campaigns (07 §7).
4. Stuck outbound: messages `queued` > 15 min → re-enqueue once, then fail with
   `INTERNAL_TIMEOUT` (NFR-R3).
5. Stale campaign claims: `claimed` recipients > 10 min without a message → back to `pending`
   (07 §6.1).
6. Failed webhook events in the last 24 h → surface the count.

**As built (2026-08-16).** Steps 1–6 are implemented in `wa-health-check`. Two details worth
recording:

- **Step 4 records its own retry.** A message queued longer than 15 minutes is re-enqueued once and
  failed the second time; the fact that it was already retried is written to
  `statusTimestamps.requeuedAt` rather than to `kv` or a new column, so it survives a cache
  eviction and an operator reading the record can see the system already tried.
- **Meta reports throughput as a level, not a number** (`STANDARD`, `HIGH`). It is stored as
  messages per second so the panel can show the headroom above `sendThrottlePerSecond`; an
  unrecognised level leaves the stored value alone rather than guessing, since a wrong ceiling here
  would licence a burst.

**Alert delivery.** There is no notification API (D-10). Alerts are delivered as:

- red rows in the settings health panel (always),
- a `whatsapp.system.alert` timeline activity on the workspace's first admin member,
- an optional outbound WhatsApp message to `WA_ALERT_PHONE_NUMBERS` using an operator-provided
  **utility** template — the one place where the product can page its own operator. Off by
  default; enabling it requires a template that the operator has published.

---

## 4. Deployment topology (TRD §12.1)

Standard Twenty Docker Compose (server + worker + PostgreSQL 16 + Redis) behind a TLS-terminating
reverse proxy. The app adds **no** service and **no** extra ingress — its endpoints are paths on
the Twenty server.

Media storage follows the instance's `STORAGE_*` configuration (local volume or S3-compatible).
Because media files and the database reference each other, **they must be backed up together** —
stated explicitly in the runbook, since a database-only restore silently produces broken
attachments.

### Reverse proxy configuration

Needed for the D-1 single-URL callback. **Caddy:**

```caddy
example.com {
    @wa_verify { path /whatsapp/webhook
                 method GET }
    @wa_events { path /whatsapp/webhook
                 method POST }

    handle @wa_verify {
        rewrite * /s/whatsapp/verify?{query}
        reverse_proxy twenty:3000
    }
    handle @wa_events {
        rewrite * /webhooks/server/bb76f114-7843-4a09-af64-9ceca78479cd
        reverse_proxy twenty:3000
    }
    handle { reverse_proxy twenty:3000 }
}
```

**Nginx:**

```nginx
location = /whatsapp/webhook {
    if ($request_method = GET)  { rewrite ^ /s/whatsapp/verify?$args last; }
    if ($request_method = POST) { rewrite ^ /webhooks/server/bb76f114-7843-4a09-af64-9ceca78479cd last; }
    return 405;
}
```

Two proxy requirements that will otherwise cost a day of debugging:

- **Do not buffer or re-encode the request body.** The HMAC is computed over the exact bytes;
  any rewriting (charset normalisation, gzip re-encoding) invalidates every signature.
- Keep `client_max_body_size` above the largest expected webhook payload (they are small, but a
  batch of statuses plus contacts can reach tens of kilobytes).

---

## 5. Operational procedures

### 5.1 Installation runbook (TRD §12.2)

**Meta side** (start business verification at kickoff — §14.2, R-10):

1. Create a Meta app (Business type) → add the WhatsApp product.
2. Create or link the WABA; register the phone number
   (`POST /{phone_number_id}/register` with a 2FA PIN); submit the display name for review.
3. Create a System User, assign the WABA, generate a token with exactly
   `whatsapp_business_messaging` + `whatsapp_business_management`. Record the App Secret.

**Twenty side:**

4. Deploy the app (`yarn twenty app:publish --target server` then `yarn twenty app:install`, or
   Settings → Applications).
5. Set the four server variables (`META_APP_ID`, `META_APP_SECRET`, `META_ACCESS_TOKEN`,
   `META_VERIFY_TOKEN` — generate the verify token with `openssl rand -hex 32`).
6. Add the reverse-proxy block (§4) and reload the proxy.
7. In the app settings: enter WABA ID + `phone_number_id`, click **Test connection**.
8. Copy the callback URL from the settings card into the Meta App dashboard → WhatsApp →
   Configuration; paste the verify token; **Verify and save**.
9. Subscribe the webhook fields: `messages`, `message_template_status_update`,
   `message_template_quality_update`, `message_template_components_update`, `account_update`,
   `phone_number_quality_update`, `account_review_update`, `phone_number_name_update` (AR-10).
10. **Subscribe the app to the WABA** — `POST /{waba_id}/subscribed_apps` — then **verify it**:

    ```bash
    curl -s "https://graph.facebook.com/v26.0/${WABA_ID}/subscribed_apps" \
      -H "Authorization: Bearer ${META_ACCESS_TOKEN}"
    # must list your app; `{"data":[]}` means NO events will ever arrive
    ```

    > **This step is the single most likely install failure, and it fails silently.**
    > Verifying the callback URL registers the endpoint against the *app*; it does not connect
    > the *WABA* to it. With the subscription missing, the dashboard shows a verified, `active`
    > callback with every field subscribed, the dashboard's **Test** button delivers
    > successfully — and real messages are discarded by Meta with no error on either side.
    > Confirmed on this project during the week-1 capture session (2026-08-15).
    >
    > Events sent while unsubscribed are **not** backfilled once you subscribe. They are lost.
    >
    > The subscription is per-WABA: adding a number under a second WABA (FR-ACC-6) needs its own
    > `POST /{waba_id}/subscribed_apps`.

    Cross-check the app-level side too, which reveals the callback URL and field list Meta
    actually holds:

    ```bash
    curl -s "https://graph.facebook.com/v26.0/${META_APP_ID}/subscriptions?access_token=${META_APP_ID}%7C${META_APP_SECRET}"
    ```
11. Run the built-in checklist: send a message *to* the business number from a real device, then
    reply from the CRM. Both directions green = done.

### 5.2 Token rotation (SEC-4)

Generate a new System User token → update `META_ACCESS_TOKEN` in settings → click **Test
connection** (or wait for the hourly health check). No redeploy, no downtime. Queued messages
resume automatically because the sender reads the secret per invocation.

### 5.3 Graph API version upgrade (C-7)

Change `META_GRAPH_VERSION` in **staging** → run the contract and E2E suites (12) → promote.
Review at least annually; versions live ~2 years and v26.0 will be removed around mid-2028.

### 5.4 Backup and restore

Standard Twenty backup covers the workspace schema. Additionally: back up the media storage
volume/bucket in the same window as the database dump, and record the app version installed —
restoring a database that references app objects from a newer manifest will fail metadata sync.

### 5.5 Upgrading Twenty

Never upgrade production ahead of the weekly compatibility job (01 §6). Procedure: compat job
green on version X → upgrade staging to X → run integration + E2E → upgrade production. Pin the
image tag; `latest` in production is explicitly forbidden by this runbook.

**As built (2026-08-17).** The pin is a file — `.twenty-version` at the repo root — and `ci.yml`
reads it, so every pull request is tested against the version production runs. `compat.yml` runs
weekly against `twentycrm/twenty:latest` and, on failure, opens (or comments on) a single issue
labelled `twenty-compat`; one issue rather than one per week, so a break that takes a month to fix
does not train everyone to ignore the label. `workflow_dispatch` accepts a version, which is how
you test a specific upgrade target before scheduling it.

The upgrade is therefore: dispatch `compat.yml` against X → green → bump `.twenty-version` to X in
a pull request (CI now runs against X) → upgrade staging → E2E → upgrade production.

---

## 6. Replay and reconciliation (TRD §12.4, NFR-R1)

Because Meta retries for only 7 days and offers **no replay API**, the
`whatsappWebhookEvent` table is the sole source for reprocessing — which is why its retention
floor is 7 days (10 §4.2).

**Diagnostics tab** (settings, admin-only):

- List `whatsappWebhookEvent` filtered by `processingStatus` and date, with the payload viewer.
- **Replay selected** → `POST /whatsapp/replay { eventIds }` re-enqueues the original processor
  with the original payload. Replays are idempotent by construction (D-12), so replaying a
  successful event is harmless — an important property, because operators will do it.
- **Replay all failed in range** with a confirmation showing the count.
- **Resync thread** → re-runs template/status reconciliation for one thread.
- Every replay is audit-logged (10 §5).

**As built (2026-08-17)** — `wa-webhook-replay-route`, `POST /s/whatsapp/replay`, admin-only for
every action including the read: the payloads hold message bodies, phone numbers and profile
names, which makes this the most sensitive table the app owns.

| Action | Body | Behaviour |
|---|---|---|
| `list` | `statuses[]`, `since`, `until`, `limit`, `after` | The raw log, newest first, paged |
| `replay` | `eventIds[]` | Re-drives the named events; ids that no longer exist come back in `missing` rather than being ignored — the likeliest reason is that the purge removed them, and "4 of the 6 you selected" is what lets an operator work out why the fifth conversation is still wrong |
| `replayFailed` | `since`, `until`, `dryRun` | `dryRun` (the default) returns the count the confirmation shows; the real run is capped at 200 per request and reports `truncated` so the operator presses again |
| `resyncThread` | `threadId`, `since`, `dryRun` | Every stored event mentioning that conversation's `wa_id`, scoped to its own account |

Three properties are load-bearing and are unit-tested as such:

- It re-enqueues through **`jobsForChange`**, the same fan-out the live path uses. A replay-only
  dispatcher would be a second copy of the routing table, and the drift would surface during an
  incident.
- The account is **re-resolved from the payload** exactly as ingest resolved it, so a replay
  cannot land in a different account than the original.
- A row is marked back to `RECEIVED` only **after** something was actually queued. The other
  order takes a row out of the failed list with nothing scheduled to process it — the one state in
  which the loss is invisible.

`resyncThread` searches the payload with a `like` over serialised JSON. That is a scan, not an
index, which is why it is bounded by the retention window and a limit and lives nowhere near a
hot path.

**Failure triage order** (put in the runbook verbatim):

1. Health panel red rows — token, webhook staleness, stuck sends.
2. `wa.webhook.signature_rejected` climbing → the App Secret is wrong or the proxy is mutating
   the body.
3. `wa.webhook.unclaimed` climbing → the kv claim is missing; re-run **Test connection**.
4. `wa.status.orphan` climbing → sends are not recording WAMIDs; check the sender's logs.
5. `wa.send.unmapped_error` non-zero → a new Meta error code; add a row to appendix B.

---

## 7. Failure-mode behaviour (NFR-R4)

| Failure | Behaviour |
|---|---|
| Meta API down | Sends retry with backoff (04 §7); inbound is buffered by Meta for 7 days; recovery is automatic |
| Twenty server restart | In-flight jobs are retried by the platform queue; `queued` messages are recovered by the health check |
| Postgres unavailable | Resolver throws → non-2xx → Meta retries; no data loss inside the 7-day horizon |
| Token revoked | Account → `error`, sends paused, admin alerted; inbound continues to be ingested |
| Number suspended | Account → `error`; campaigns paused; the UI links to Business Support Home |
| Core API rate limited | `src/server/batching.ts` backs off adaptively and counts `wa.api.core_429`; sustained overrun alerts (NFR-R2) |
| Disk/quota full on media storage | Media worker fails, sets `downloadFailed`, message text is unaffected; alert on `wa.media.failed` |

---

## 8. Capacity notes

At the A-5 initial volume (5 000 messages/day) the app adds roughly: 5 000 sends + 15 000 status
webhooks + ~20 000 raw event rows per day, ~1–2 GB/month of media at typical mix, and a steady
~4 background jobs/second. That is comfortably inside the TRD's 2 GB minimum instance.

At the NFR-S1 design point (50 000/day) the binding constraints, in order, are: the Core API
request budget (mitigated by batching and the aggregated feed route), `whatsappWebhookEvent`
growth (mitigated by the 30-day purge — non-optional at this scale), and media storage
(mitigated by S3 offload and the retention policy).
