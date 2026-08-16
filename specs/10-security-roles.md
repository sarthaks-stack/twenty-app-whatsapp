# 10 — Security, roles and data protection

Implements SEC-1 … SEC-12, AR-2, AR-3, AR-6.

---

## 1. Secrets (SEC-1, SEC-4, AR-2)

| Control | Implementation |
|---|---|
| Storage | Declared as `serverVariables` with `isSecret: true` in `application-config.ts`; Twenty encrypts them at rest with the instance `APP_SECRET`. No secret ever appears in a record field, a manifest value, or a front-component bundle. |
| Access | Only via `requireSecret(name)` (01 §4.1), which fails closed. There is no default, no `?? ''`, no "development fallback". |
| Front-end exposure | Front components can read only non-secret application variables via `getApplicationVariable()` — the platform does not send secrets to the sandbox (verified in the docs). AR-3 is therefore enforced by the platform, and reinforced by the lint rule banning `graph.facebook.com` outside `src/providers/`. |
| Logging | `src/server/logger.ts` is the only module permitted to call `console.*` (lint-enforced). It runs every payload through a redactor that replaces any value matching a secret's current value, any `Authorization` header, any `access_token`/`app_secret`/`verify_token` key, and any string longer than 100 chars that is base64/hex-shaped, with `«redacted»`. |
| Rotation (SEC-4) | Update the server variable in Settings → the next `requireSecret` call picks it up; `wa-health-check` verifies within the hour, or the admin clicks "Test connection" for an immediate check. No redeploy, no restart, no downtime. Runbook: [11 §5](11-observability-operations.md#5-operational-procedures). |
| Scope | The System User token must carry exactly `whatsapp_business_messaging` and `whatsapp_business_management`. The connect flow calls `GET /debug_token` and **warns** if broader scopes are present. |

A CI job greps the built bundle for the literal values of test secrets to prove nothing leaked
(12-testing.md, Security row).

---

## 2. Webhook authenticity (SEC-2, SEC-3, AR-6)

Specified in [03 §2](03-webhook-ingestion.md#2-wa-webhook-resolver--signature-routing-dispatch).
The security-relevant invariants:

1. HMAC-SHA256 over **`rawBody` as received**, keyed with `META_APP_SECRET`, compared in constant
   time over equal-length digests. Any failure → `401`, zero side effects.
2. Verification happens **before** `JSON.parse` of the body is trusted for anything.
3. The GET handshake compares `hub.verify_token` in constant time and never logs either value.
4. `signature_rejected` is counted; a rate exceeding
   `WA_SIGNATURE_REJECT_ALERT_THRESHOLD` (default 20/hour) raises an admin alert — an unsigned
   flood is either a misconfiguration or probing, and both deserve attention.
5. TLS is mandatory (Meta requires it); the runbook rejects any deployment where the callback is
   reachable over plain HTTP.

**Replay protection.** Meta's signature has no timestamp, so a captured valid request can be
replayed. Our defence is idempotency rather than rejection: every replayed change collides on
`whatsappWebhookEvent.dedupKey` and every replayed message on `wamid` (D-12). A replay therefore
produces `dedup_hit` counters and no state change. This is stated explicitly because it is the
question a security reviewer will ask.

---

## 3. Roles (SEC-5, SEC-7, SEC-12)

Three roles ship with the app.

### 3.1 `default-role.ts` — the function role

The identity logic functions run as. Scoped down from the scaffolded template: it needs write
access to the app's own objects, read/write on `person` (auto-creation, consent field), read on
`workspaceMember`, and write on `timelineActivity`. It does **not** get
`canDestroyAllObjectRecords` and does **not** get `canUpdateAllSettings`.

It **does** get two discrete permission flags, `SystemPermissionFlag.UPLOAD_FILE` and
`DOWNLOAD_FILE`, without which the media worker's attachment fails with *"Entity performing the
request does not have permission"* — a message naming neither the permission nor the file.
Granting `canUpdateAllSettings` would also have worked and would have been a poor trade: it hands
every handler the data model, roles and billing in exchange for one file upload.

### 3.2 `WhatsApp Agent` (`ROLE_AGENT`)

| Object | Read | Update | Delete |
|---|---|---|---|
| whatsappThread | ✅ | ✅ (assignee, status, unread) | ❌ |
| whatsappMessage | ✅ | ❌ (messages are written by the app only) | ❌ |
| whatsappTemplate | ✅ | ❌ (cannot publish) | ❌ |
| whatsappAccount | ✅ | ❌ | ❌ |
| whatsappCampaign / Recipient | ✅ | ❌ | ❌ |
| whatsappConsentEvent | ✅ | ❌ (creation goes through the audited route) | ❌ |
| whatsappWebhookEvent | ❌ | ❌ | ❌ |
| person | ✅ | ✅ | ❌ |

### 3.3 `WhatsApp Admin` (`ROLE_ADMIN`)

Everything the agent has, plus: update `whatsappAccount` and `whatsappTemplate`
(incl. `publishedToCrm`), full campaign control, consent import, webhook-event read and replay,
and the app's settings section.

### 3.4 Server-side re-checks (SEC-5)

Object permissions protect the Core API. They do **not** protect our HTTP routes, which run with
the app's own role. Therefore every route in `src/logic-functions/*-route.ts` begins with:

```ts
const caller = await requireCaller(event);                  // resolves userWorkspaceId → member + roles
requireRole(caller, 'admin');                               // or 'agent'
```

Two behaviours established against the running platform rather than assumed:

- **A Twenty workspace administrator counts as a WhatsApp admin** (`canUpdateAllSettings`).
  Without this a fresh install has nobody able to connect a number — the app ships its roles and
  assigns them to no one, including the person who installed it.
- **An authenticated caller with no membership is a *machine* caller, not an anonymous one.**
  Verified: on an `isAuthRequired: true` route the platform rejects a missing or invalid token
  before the handler runs ("Missing authentication token" / "Token invalid."), so a null
  `userWorkspaceId` means a valid API key. Such a key is treated as admin, because refusing it
  would not be a control — an API key can already write any record through the Core API, and the
  only thing these routes uniquely own is the `kv` routing claim. What SEC-5 defends against, a
  logged-in *agent* calling an admin route, still fails. Machine actions are audited with a null
  actor.

Route-by-route requirement:

| Route | Minimum role |
|---|---|
| `/whatsapp/feed` | agent (and scoped to what the caller may see — SEC-7) |
| `/whatsapp/send` | agent |
| `/whatsapp/thread` (assign, close, relink, markRead) | agent |
| `/whatsapp/consent` (set) | agent · (import) admin |
| `/whatsapp/campaign` (all actions) | **admin** (SEC-12) |
| `/whatsapp/account` (connect, test, disconnect) | **admin** |
| `/whatsapp/templates` (publish, sync, submit) | **admin** |
| `/whatsapp/replay` | **admin** |
| `/whatsapp/verify` | none (unauthenticated by design; protected by the verify token) |

A front component hiding a button is a convenience, never a control. Two negative tests per
admin route (agent forbidden, anonymous forbidden) are release-blocking.

### 3.5 Thread visibility (SEC-7, SHOULD)

Default is workspace-wide — the sales team collaborates and any rep can pick up any conversation.
A per-account `visibilityMode` field (`shared` | `restricted`) switches to
"assignee + unassigned + admins". Enforcement is in the feed route's query construction, not in
the UI: a restricted thread must not be returned by `/whatsapp/feed` at all.

Row-level permission predicates (`rowLevelPermissionPredicates` in `RoleManifest`) are the
platform-native way to express this and would enforce it on the Core API too. **PROBE P-7**:
evaluate whether a predicate can express "assignee = current member OR assignee IS NULL" on the
target version; adopt it if so, otherwise the route-level filter is the shipped control and the
limitation ("a rep with API access could read a restricted thread") is documented.

### 3.6 Consent cannot be overridden (SEC-6)

There is no role, no request parameter and no UI path that permits a business-initiated send to an
`opted_out` person. The check lives in the policy module, is re-run by the sender immediately
before the HTTP call, and has a dedicated test asserting that an **admin** call to
`/whatsapp/send` with a template to an opted-out person returns `409` and produces no Meta
request. "Admin can do anything" is explicitly not true here, and that is the point.

---

## 4. Data protection (SEC-8, SEC-9, SEC-11)

### 4.1 Subject erasure (SEC-8)

`wa-erase-person` (an admin route action, `POST /whatsapp/consent { action: 'erase', personId }`)
performs, in order:

1. Collect the person's threads, messages, media file ids, consent events and campaign recipient
   rows.
2. Hard-destroy messages and threads (not soft-delete — soft-deleted rows still hold the content).
3. Delete stored media files.
4. Replace consent events with a **single tombstone**: `{ personId, erasedAt, actorId,
   eventCountRemoved }` and no content.
5. Delete campaign recipient rows, decrementing the campaigns' counters.
6. Write one `timelineActivity` `whatsapp.data.erased` with actor and date, no content.
7. Leave the Person record itself to Twenty's own deletion flow.

The tombstone is the deliberate compromise between "erase everything" and "be able to prove the
erasure happened", which is what an auditor asks for.

The route offers a dry-run mode returning the counts that would be deleted, so an operator sees
the blast radius before confirming.

**As built (2026-08-16).** Implemented in `src/server/erasure.ts`, reached through
`POST /whatsapp/consent { action: 'erase', personId }`. `dryRun` defaults to **true**: erasing
requires `dryRun: false` explicitly, so the destructive call cannot be the one you make by
forgetting a parameter.

Two things this required. `canDestroyAllObjectRecords` had to be granted to the app role (D-21) —
withheld, it made SEC-8 unimplementable while the dry run kept reporting correctly, because
counting only reads. And `whatsappConsentEvent` gained an `isTombstone` flag with a nullable
`newStatus`, so the surviving row is filterable as what it is rather than identifiable by a
substring in its notes. Verified end to end: 1 thread, 3 messages and 1 consent event destroyed,
one tombstone left carrying the counts, no wording and no status.

### 4.2 Retention (SEC-9)

`wa-retention-purge` (cron, daily at 03:00):

| Data | Setting | Default | Floor |
|---|---|---|---|
| `whatsappWebhookEvent` | `WA_RETENTION_WEBHOOK_EVENT_DAYS` | 30 | **7** (Meta's retry horizon — validation rejects less) |
| message bodies + media | `WA_RETENTION_MESSAGE_MONTHS` | 0 = unlimited | — |
| metrics counters | fixed | 90 days | — |

Message purging blanks `body`, `payload` and deletes `mediaFile`, but **keeps** the row with its
wamid, direction, status, timestamps and template metadata — so counts, delivery reporting and
cost attribution survive a content purge. The purge job logs counts only, never content.

Q-4 (legal input on retention, incl. Lei 22/11) must land before go-live; until it does, the
default is "keep everything", which is reversible in the direction the law permits.

### 4.3 Compliance notes (SEC-11)

Engineering-relevant facts, not legal advice:

- Message content is processed by Meta as part of delivery, regardless of self-hosting. The
  privacy notice and the opt-in wording must say so; the wording is an application variable so
  counsel can revise it without a deploy (06 §10).
- Self-hosting keeps the CRM copy of message content on infrastructure the business controls —
  which is what makes the retention and erasure controls above meaningful.
- Angola's Lei n.º 22/11 applies to processing contacts' personal data; where EU data subjects are
  messaged, GDPR applies. Counsel reviews the privacy notice (Q-4).
- The consent event's `wordingShown` field exists specifically to make consent provable rather
  than asserted.

---

## 5. Audit (SEC-10, SEC-12)

Audited actions, all written through `src/server/audit.ts` as timeline activities plus a
structured log line:

| Action | Recorded |
|---|---|
| Template send | who, template, recipient, campaign?, timestamp |
| Consent change | who, from → to, method, wording shown |
| Thread assignment / re-link | who, from → to |
| Template publish / unpublish | who, template, direction |
| Account connect / disconnect / settings change | who, field-level diff **with secrets excluded** |
| Campaign create / launch / pause / resume / cancel | who, previous state, audience definition snapshot, exclusion counts, template (SEC-12) |
| Webhook replay | who, event ids |
| Erasure | who, person, counts |

Campaign launch is the highest-stakes entry: it records the full `audienceDefinition`,
`recipientCount`, `exclusionBreakdown`, `estimatedCostUsd` and template so the question "who sent
5 000 messages and to whom" is answerable months later without reconstructing state.

---

## 6. Threat notes

| Threat | Control |
|---|---|
| Forged webhook | HMAC over raw body, constant-time (§2) |
| Replayed webhook | Idempotency, not rejection (§2) |
| Secret exfiltration via front component | Platform never sends secrets to the sandbox; lint + bundle-grep CI (§1) |
| Privilege escalation through the UI | Server-side role re-check on every route (§3.4) |
| Messaging an opted-out contact | Unoverridable policy gate, re-checked at send (§3.6) |
| Cross-workspace data leak via a shared resolver | Account ownership re-verified inside the target workspace (03 §2.2) |
| Template-injection into customer messages | Bindings resolve only against an allow-list; parameters sanitised (06 §5) |
| Media path traversal on stored filenames | Storage filename derived from the wamid, never from sender input (03 §8) |
| Runaway spend | Pre-flight cost display, tier reserve, circuit breaker, admin-only launch (07) |
| Number suspension through misuse | Consent gating, RED blocks, quality auto-pause, admin-gated templates (R-5, R-11) |
