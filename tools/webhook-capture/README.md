# Meta webhook capture harness

Records real, signed WhatsApp webhook deliveries as test fixtures — **before** the app exists.

It does three jobs at once:

1. **Answers probe P-1** ([specs/00 D-1](../../specs/00-architecture-decisions.md#d-1--the-meta-callback-url-is-platform-assigned-not-author-chosen)) —
   does Meta accept our GET handshake response?
2. **Captures the fixture set** required by [specs/12 §4](../../specs/12-testing.md), unblocking
   workstream B.
3. **Proves the production HMAC verifier against genuine Meta signatures.** The harness imports
   `verifyMetaSignature` from `src/providers/whatsapp/` — the same function the
   `wa-webhook-resolver` logic function will use — so a green capture session *is* the conformance
   test, not a rehearsal of one.

No Twenty, no database, no app install required.

---

## Prerequisites

`.dev.vars` must contain:

| Variable | Where it comes from |
|---|---|
| `META_APP_SECRET` | Meta app → Settings → Basic → App Secret |
| `META_VERIFY_TOKEN` | Any random string. Generate with `openssl rand -hex 32` |

`.dev.vars` is gitignored. Never commit it.

---

## Run it

**Terminal 1 — the harness:**

```bash
yarn capture
```

**Terminal 2 — a tunnel** (either works; both terminate valid TLS, which is Meta's only requirement):

```bash
cloudflared tunnel --url http://localhost:8787
# or
ngrok http 8787
```

Copy the `https://…` URL it prints.

**Meta dashboard** → your app → WhatsApp → Configuration → Webhook → *Edit*:

| Field | Value |
|---|---|
| Callback URL | `https://<tunnel-host>/whatsapp/webhook` |
| Verify token | the `META_VERIFY_TOKEN` value from `.dev.vars` |

Click **Verify and save**. The harness prints:

```
GET  /whatsapp/webhook → 200 handshake OK (probe P-1 passed)
```

Then **Manage** → subscribe these fields ([AR-10](../../specs/03-webhook-ingestion.md)):

`messages` · `message_template_status_update` · `message_template_quality_update` ·
`account_update` · `phone_number_quality_update` · `account_review_update` ·
`phone_number_name_update`

---

## Capture the fixtures

Message the test number from an allowlisted device. After every delivery the harness prints the
signature verdict, the fixture written, and **what to send next**:

```
POST sig ✓ inbound-image + status-delivered → inbound-image--2026-08-15T15-27-53-781Z.json
  coverage 3/17 — next: inbound-text-reply (Long-press one of your own messages → Reply, then send text)
```

Work the checklist down to `coverage 17/17`. The full list, with device instructions, is in
[`required-fixtures.ts`](required-fixtures.ts).

Statuses (`sent`/`delivered`/`read`) arrive automatically once you send *from* the API and open
the chat on the device.

---

## What lands where

| Path | Contents | Committed? |
|---|---|---|
| `src/__tests__/fixtures/meta/*.json` | Redacted, parseable payload + classification | **yes** |
| `src/__tests__/fixtures/meta/raw/*.json` | Exact bytes + the real Meta signature | no — gitignored |
| `src/__tests__/fixtures/meta/raw/invalid/*.json` | Deliveries that failed verification | no — gitignored |
| `src/__tests__/fixtures/meta/manifest.json` | Coverage tracking | **yes** |

**Why the split.** A body paired with its valid signature is an oracle for the App Secret, so it
never leaves the machine. The committed sibling is pseudonymised: phone numbers become stable
`+2449…` values, WAMIDs become stable `wamid.…` hashes, profile names become `Test Contact XXXX`.
Redaction is deterministic, so `contacts[].wa_id` and `messages[].from` still agree — a fixture
where they diverged would describe a delivery Meta cannot send, and the matching tests would be
exercising nothing.

Phone numbers are also scrubbed out of free text and Meta `error_data.details`. Message **bodies
are kept verbatim**, so don't type anything sensitive on the test device.

---

## Unverifiable deliveries

A body whose signature does not verify is **not** written as a fixture and earns no coverage
credit. It is quarantined in `raw/invalid/`, and `yarn test:unit` fails until you triage it:

- **It came from Meta** → a real bug. Check `META_APP_SECRET`, and check that the tunnel is not
  re-encoding the request body ([specs/11 §4](../../specs/11-observability-operations.md#reverse-proxy-configuration)).
- **It came from an internet scanner** → delete the file.

Silence is not an option here by design: an unverifiable delivery is either a defect or an
intrusion attempt.

---

## The tests this feeds

```bash
yarn test:unit
```

- `src/providers/whatsapp/verify-signature.test.ts` — the verifier against signatures we compute
  ourselves, including the re-serialisation regression guard (Meta escapes non-ASCII as `\uXXXX`;
  verifying `JSON.stringify(JSON.parse(raw))` passes every ASCII test and then rejects every real
  Portuguese message).
- `src/__tests__/captured-signatures.test.ts` — the same verifier against **real** captures. Skips
  cleanly with no captures and on CI, and becomes a hard gate on any machine that has captured.
  It also asserts raw bytes and the utf8-decoded string agree, because `twenty-sdk` hands the
  resolver a `string`, never a `Buffer`.
- `src/domain/webhook/classify-change.test.ts`, `redact.test.ts` — the pure logic the harness and
  `wa-webhook-ingest` share.

---

## Cannot be captured with a test number

Five shapes must be hand-written from
[specs/appendix-a §5](../../specs/appendix-a-meta-api.md) and marked `"synthetic": true` — they
are the fixtures most likely to be subtly wrong, so they must be visibly distinguishable from
real captures:

| Slug | Why |
|---|---|
| `inbound-text-referral` | needs a live Click-to-WhatsApp ad |
| `inbound-interactive-nfm-reply` | needs a published WhatsApp Flow |
| `account-update-*` | needs a real policy violation |
| `phone-quality-red` | needs real quality degradation |
| `status-failed-131049` | needs the per-user marketing cap to trigger |

The last three drive the campaign guardrails (AR-22), so those paths stay synthetic-only until
production. Note that in the release-gate discussion.

---

## Options

| Variable | Default | Purpose |
|---|---|---|
| `CAPTURE_PORT` | `8787` | listening port |

`GET /health` returns `{"ok":true}` for tunnel checks.
