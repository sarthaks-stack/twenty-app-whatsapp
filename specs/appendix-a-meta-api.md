# Appendix A — Meta Cloud API surface

Every Meta interaction the app performs. Nothing outside this list is called; anything added here
must be added to `WhatsAppProvider` (D-14) and to the contract tests.

Base: `https://graph.facebook.com/${META_GRAPH_VERSION}` (default `v26.0`, pinned — C-7).
Auth: `Authorization: Bearer ${META_ACCESS_TOKEN}` on every call.

---

## 1. Endpoints used

| Purpose | Call | Used by |
|---|---|---|
| Send any message | `POST /{phone_number_id}/messages` | `wa-outbound-sender` **only** (AR-11) |
| Mark as read / typing | `POST /{phone_number_id}/messages` with `{status:'read', message_id}` | `wa-thread-actions-route` |
| Upload media | `POST /{phone_number_id}/media` (multipart) | `wa-outbound-sender` |
| Resolve media URL | `GET /{media_id}` | `wa-media-worker` |
| Download media | `GET <returned url>` with the Bearer token | `wa-media-worker` |
| List templates | `GET /{waba_id}/message_templates?limit=100&after=<cursor>` | `wa-template-sync` |
| Create template | `POST /{waba_id}/message_templates` | template submission (FR-TPL-6) |
| Phone number health | `GET /{phone_number_id}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,throughput` | `wa-health-check`, connect test |
| Subscribe app to WABA | `POST /{waba_id}/subscribed_apps` | connect flow (documented as a manual step, automated if permitted) |
| Register number | `POST /{phone_number_id}/register` | **manual, runbook only** — never called by the app |
| Token introspection | `GET /debug_token?input_token=…` | connect flow, to warn on over-broad scopes |

`POST /{phone_number_id}/register` is deliberately excluded from the provider: registering a
number is a one-time operator action with a 2FA PIN, and putting it behind a button invites
accidents.

---

## 2. Send payloads

Common envelope:

```jsonc
{ "messaging_product": "whatsapp", "recipient_type": "individual", "to": "<wa_id>", "type": "<type>" }
```

`to` is always the thread's `waId`, never `dialablePhone` (FR-CID-2, 04 §6).

| Type | Body fragment |
|---|---|
| text | `"text": { "body": "…", "preview_url": true }` |
| reply | add `"context": { "message_id": "wamid.…" }` to any type |
| image / video / audio / document / sticker | `"image": { "id": "<media_id>", "caption": "…" }` — **`id`, never `link`** (AR-14). Documents also take `"filename"` |
| location | `"location": { "latitude": …, "longitude": …, "name": "…", "address": "…" }` |
| contacts | `"contacts": [ … ]` |
| reaction | `"reaction": { "message_id": "wamid.…", "emoji": "👍" }` (empty string removes) |
| interactive buttons | `"interactive": { "type": "button", "body": {...}, "action": { "buttons": [ {"type":"reply","reply":{"id":"…","title":"…"}} ] } }` — max 3 |
| interactive list | `"interactive": { "type": "list", "action": { "button": "…", "sections": [...] } }` |
| template | see below |

Template:

```jsonc
{ "type": "template",
  "template": {
    "name": "<name>", "language": { "code": "pt_PT" },
    "components": [
      { "type": "header", "parameters": [ { "type": "image", "image": { "id": "…" } } ] },
      { "type": "body",   "parameters": [ { "type": "text", "text": "…" } ] },
      { "type": "button", "sub_type": "url", "index": "0",
        "parameters": [ { "type": "text", "text": "…" } ] }
    ] } }
```

Named parameters (used only when `variableSpec.namedParameters` is true):
`{ "type": "text", "parameter_name": "customer_name", "text": "Marcos" }`.

**Parameter rules enforced before sending** (Meta rejects otherwise): no newlines, no tabs, no
more than four consecutive spaces, non-empty, within the template's length limit.

Success response:

```jsonc
{ "messaging_product": "whatsapp",
  "contacts": [ { "input": "244923000000", "wa_id": "244923000000" } ],
  "messages": [ { "id": "wamid.HBgM…", "message_status": "accepted" } ] }
```

`messages[0].id` is the WAMID stored on the record — the idempotency key for everything that
follows.

---

## 3. Media

**Upload** — `POST /{phone_number_id}/media`, multipart with
`messaging_product=whatsapp`, `type=<mime>`, `file=<binary>` → `{ "id": "<media_id>" }`.
Uploaded ids are valid **7 days** (reduced from 30 on 2025-10-09), so the content-hash cache
expires at 6 days (04 §5).

**Inlined on the webhook** — real inbound media payloads include the CDN URL directly
(`messages[].image|audio|video|document.url`) with an `ext` expiry (~10 min observed) and a
`hash` token. Undocumented by Meta but present in practice; use it to skip a round-trip when the
media worker runs promptly, and always keep the resolution path below for retries and deferred
downloads (03 §8).

**Resolve** — `GET /{media_id}` →
`{ "url": "https://lookaside.fbsbx.com/…", "mime_type": "image/jpeg", "sha256": "…", "file_size": 12345, "id": "…" }`.
The URL expires in ~5 minutes and requires the Bearer token on download (C-6). On 404/410, re-call
`GET /{media_id}` for a fresh URL — the media id itself remains valid for 7 days.

**Limits** (mirrored as validation, AR-16):

| Kind | Max | Types |
|---|---|---|
| image | 5 MB | jpeg, png |
| audio | 16 MB | aac, amr, mp3, mp4, ogg (opus) |
| video | 16 MB | mp4, 3gp (single audio stream, H.264 + AAC) |
| document | 100 MB | any |
| sticker | 100 KB static / 500 KB animated | webp |

Our inbound auto-download ceiling is 25 MB regardless of Meta's limits (D-8).

---

## 4. Templates

`GET /{waba_id}/message_templates` returns:

```jsonc
{ "data": [ { "id": "…", "name": "proposta_setembro", "language": "pt_PT",
              "status": "APPROVED", "category": "MARKETING",
              "quality_score": { "score": "GREEN" },
              "components": [
                { "type": "HEADER", "format": "IMAGE", "example": { "header_handle": ["…"] } },
                { "type": "BODY", "text": "Olá {{1}}, …", "example": { "body_text": [["Marcos"]] } },
                { "type": "FOOTER", "text": "Responda SAIR para cancelar" },
                { "type": "BUTTONS", "buttons": [ { "type": "URL", "text": "Ver", "url": "https://…/{{1}}" } ] } ] } ],
  "paging": { "cursors": { "after": "…" }, "next": "…" } }
```

Creation (`POST`) requires `name`, `language`, `category`, `components` **with `example` values
for every placeholder** — the most common first-attempt rejection.

Operational limits: 100 template creations per WABA per hour (enforced locally at 90, 06 §6);
250 templates for unverified portfolios, 6 000 for verified.

---

## 5. Webhook payloads

Envelope for every delivery:

```jsonc
{ "object": "whatsapp_business_account",
  "entry": [ { "id": "<waba_id>", "changes": [ { "field": "messages", "value": { … } } ] } ] }
```

`value` for the `messages` field:

```jsonc
{ "messaging_product": "whatsapp",
  "metadata": { "display_phone_number": "244…", "phone_number_id": "<phone_number_id>" },
  "contacts": [ { "profile": { "name": "Ana" }, "wa_id": "244923000000" } ],
  "messages": [ { "from": "244923000000", "id": "wamid.…", "timestamp": "1786000000",
                  "type": "text", "text": { "body": "Olá" },
                  "context": { "id": "wamid.…" },
                  "referral": { "source_url": "…", "source_type": "ad", "headline": "…" } } ],
  "statuses": [ { "id": "wamid.…", "status": "delivered", "timestamp": "1786000001",
                  "recipient_id": "244923000000",
                  "conversation": { "id": "…", "origin": { "type": "marketing" } },
                  "pricing": { "billable": true, "category": "marketing", "pricing_model": "PMP" },
                  "errors": [ { "code": 131047, "title": "…", "error_data": { "details": "…" } } ] } ],
  "errors": [ … ] }
```

Critical properties, all of which the design assumes:

- **`messages` and `statuses` can appear in the same `value`** — hence the ingest fan-out (D-2).
- **One POST may carry multiple `entry` and multiple `changes`.**
- **At-least-once delivery, retried up to 7 days, duplicates possible, no ordering guarantee** —
  hence dedup keys (D-12) and the monotonic status machine (AR-9).
- `timestamp` is a **string** of epoch seconds.
- `statuses[].pricing.category` is the authoritative billing category for cost attribution.

Other subscribed fields:

| Field | `value` highlights |
|---|---|
| `message_template_status_update` | `message_template_id`, `message_template_name`, `message_template_language`, `event` (APPROVED/REJECTED/PAUSED/DISABLED), `reason` |
| `message_template_components_update` | `message_template_id`, changed header/body/footer/buttons. Meta may edit an approved template's components; without this the local `components` and `variableSpec` silently drift and sends fail with 132000/132012 |
| `message_template_quality_update` | `previous_quality_score`, `new_quality_score` |
| `phone_number_quality_update` | `display_phone_number`, `event`, `current_limit` |
| `account_update` | `event` (e.g. `ACCOUNT_VIOLATION`, `ACCOUNT_RESTRICTION`), `ban_info`, `restriction_info` |
| `account_review_update` | `decision` |
| `phone_number_name_update` | `decision`, `requested_verified_name` |

---

## 6. Signature and verification

**GET handshake:**
`GET {callback}?hub.mode=subscribe&hub.challenge=<n>&hub.verify_token=<t>` → respond `200` with
the **bare challenge string** as the body (`text/plain`; a JSON-quoted body fails).

**POST signature:**
`X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 of the **raw request body bytes** keyed with the
Meta **App Secret**. Verify before parsing; compare in constant time (10 §2).

---

## 7. Pricing (per-message model since 2025-07-01)

| Situation | Billed |
|---|---|
| Free-form message inside the customer service window | free |
| Utility template inside the service window | free |
| Marketing template | always billed |
| Utility / authentication template outside the window | billed |
| Free Entry Point conversation (72 h) | free |

Indicative **Rest of Africa** rates (Angola) from the 2026-04-01 card, third-party mirrored and
**pending verification (Q-1)**: marketing ≈ **$0.0225**, utility ≈ **$0.0040**,
authentication ≈ **$0.0040** per *delivered* message. Held in application variables so a
correction is a settings edit (01 §4.2).

Worked example: 1 000-recipient marketing campaign ≈ **$22.50** per wave, billed on delivery so
actuals land slightly lower. The binding constraint is usually the tier, not the cost — an
unverified portfolio (250 unique users/24 h) needs 4 days for that campaign (AR-21, R-10).

---

## 8. Messaging limits and throughput

| Aspect | Value |
|---|---|
| Business-initiated unique users / 24 h | 250 → 1 000 → 2 000 → 10 000 → 100 000 → unlimited, per business portfolio |
| Auto-scaling | on sustained quality + utilisation |
| Throughput | 80 messages/second per number by default, upgradeable to 1 000 |
| Our default ceiling | 20/s, split 40 % interactive / 60 % campaign (D-5) |
| Quality rating | GREEN / YELLOW / RED per number, driven by blocks and reports |

---

## 9. `WhatsAppProvider` interface (D-14)

```ts
export type WhatsAppProvider = {
  sendMessage(i: { phoneNumberId: string; payload: SendPayload }): Promise<{ wamid: string; raw: unknown }>;
  markAsRead(i: { phoneNumberId: string; wamid: string }): Promise<void>;
  uploadMedia(i: { phoneNumberId: string; buffer: Buffer; mimeType: string; filename: string }): Promise<{ mediaId: string }>;
  fetchMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string; fileSize: number; sha256: string }>;
  downloadMedia(url: string): Promise<{ buffer: Buffer; mimeType: string }>;
  listTemplates(wabaId: string, cursor?: string): Promise<{ templates: MetaTemplate[]; nextCursor?: string }>;
  createTemplate(wabaId: string, definition: MetaTemplateDefinition): Promise<{ id: string; status: string }>;
  getPhoneNumber(phoneNumberId: string): Promise<MetaPhoneNumber>;
  subscribeApp(wabaId: string): Promise<void>;
  verifyWebhookSignature(rawBody: string, header: string | undefined): boolean;
  parseWebhook(body: unknown): NormalisedWebhookEvent[];
};
```

Every method throws `MetaApiError { code, subcode, title, details, httpStatus, retryable }`,
classified by appendix B. A conformance test asserts the implementation satisfies the type and
that no other module imports the raw HTTP layer.
