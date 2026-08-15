# 12 — Test plan

Implements TRD §13. Release acceptance = every MUST and SHOULD requirement has at least one
passing test in the matrix of §7.

Two commands, two speeds:

- `yarn test:unit` — everything under `src/domain/**` plus pure provider helpers. No server, no
  network. **Must stay under 10 seconds.** This is where the majority of the risk lives, because
  the hard parts of this system (window maths, phone variants, status ordering, exclusion rules,
  tier budgeting) are all pure functions by design (01 §1).
- `yarn test` — `*.integration-test.ts` against a live Twenty via the scaffolded `global-setup.ts`.

> **`yarn test` is destructive.** The scaffolded `global-setup.ts` uninstalls the app before *and*
> after every run, which deletes every record its objects own — conversations, messages, media,
> campaign history, the connected number and its `kv` routing claim. Nothing about the command says
> so. A guard now counts `whatsappAccounts`, `whatsappThreads` and `whatsappMessages` first and
> refuses to run unless all three are empty or `WA_ALLOW_DESTRUCTIVE_TESTS=true` is set, so
> integration tests belong to a scratch workspace and saying otherwise has to be deliberate.
>
> The outbound integration suite is additionally **non-sending by construction**: its fixture
> account is left `PENDING`, so the policy gate's first rule denies every send, and a final test
> asserts nothing was left `QUEUED`.

---

## 1. Unit tests (`src/domain/**`)

### 1.1 Policy module (`policy/*.test.ts`) — AR-17

- Window open/closed at the boundary: `expiry - 1ms`, `expiry`, `expiry + 1ms`.
- 24 h vs 72 h FEP windows; a standard inbound after a FEP inbound resets to 24 h.
- All-UTC arithmetic across a DST transition in a European timezone and across the Angolan
  new year — the assertion is that **nothing changes**, because the module never touches local
  time.
- The full denial-precedence table (04 §1): 7 rules × allowed/denied, asserting *which* reason
  wins when several apply (e.g. opted-out **and** window closed → `opted_out`, because consent
  precedes window).
- Free-form reply to an `opted_out` contact inside an open window → **allowed**.
- Marketing template to `unknown` 1:1 → allowed with warning; campaign → denied.

### 1.2 Phone normalisation (`phone/*.test.ts`) — FR-CID-1, FR-CID-2

A table-driven matrix, both directions (`toE164`, `waIdToE164`, `identityCandidates`):

| Input | Country | Expectation |
|---|---|---|
| `923000000`, `+244 923 000 000`, `00244923000000` | AO | all → `+244923000000` |
| `912345678` | PT (with `+351` default) | `+351912345678` |
| `5511987654321` / `551187654321` | BR | each generates the other as a candidate |
| `5491123456789` / `541123456789` | AR | 9-infix pair |
| `5215512345678` / `525512345678` | MX | 1-prefix pair |
| `+1555` , `abc`, `''`, `+2449230000000000` | — | `null` (invalid) |

Plus: a candidate set never contains duplicates; a non-BR/AR/MX number yields exactly one
candidate.

### 1.3 Status machine (`status-machine.test.ts`) — AR-9

- Exhaustive: for every ordered pair of the 7 statuses, assert the result.
- Every permutation of `{sent, delivered, read}` arriving out of order converges to `read`.
- `failed` after `delivered` → stays `delivered`, but `statusTimestamps.failed` and `errorDetail`
  are recorded.
- `failed` before `sent` → `failed`, and a later `sent` does **not** resurrect it.
- `played` and `read` do not downgrade one another.

### 1.4 HMAC verification (`verify-signature.test.ts`) — SEC-2, AR-6

- Known-good vector (fixed secret, fixed body, precomputed digest).
- Wrong secret, truncated header, missing `sha256=` prefix, empty header, `undefined` header.
- **Unicode body**: a payload containing `ção`, `ã` and an emoji, verified against the digest of
  the raw string — and a negative test proving that
  `verify(JSON.stringify(JSON.parse(rawBody)))` **fails**, which is the regression guard for the
  single most likely implementation mistake.
- Timing: comparison uses digests of equal length (assert no throw on length mismatch).

### 1.5 Dedup keys, template spec, rendering

- `buildDedupKey` for each change kind; a duplicate inbound and a legitimate status sequence.
- `deriveVariableSpec` against recorded template component fixtures: text header, media header,
  0/1/5 body variables, URL button with a variable, named parameters.
- `assessSupport` marks FLOW / CAROUSEL / LTO / CATALOG / COPY_CODE unusable with the right reason.
- `resolveParameters`: fallback used, fallback absent → `missing`, whitespace-only → missing,
  newline/tab sanitisation, per-parameter truncation.
- `buildSendPayload` golden files (§3).

### 1.6 Campaign domain

- **Exclusion matrix** — all 6 reasons, precedence order, and the marketing-vs-utility difference
  in rule 2 (utility excludes only `opted_out`).
- Duplicate detection across a 3-page snapshot (first occurrence wins, later ones excluded).
- **Tier budget**: each tier's limit, reserve rounding, `available` never negative, window roll
  resetting `used`, and `available` shrinking when Meta reports a lower tier mid-run.
- **Circuit breaker**: below / at / above threshold, and behaviour with fewer than N outcomes
  (must not trip on the first failure of a 5-message campaign).
- **Pacing** (`computeSlots`): spacing correctness, cursor advance, cursor in the past clamps to
  now, and the invariant that interactive slots are unaffected by a saturated campaign cursor.
- **Cost**: category rates, delivered-only accumulation, estimate vs actual.

---

## 2. Integration tests (against a live Twenty)

Run through `global-setup.ts`, which installs the app and tears it down.

- **Schema** — every object and field exists with the expected type; every relation resolves both
  ways; all 8 indexes exist and the unique ones reject duplicates.
- **Resolver → ingest → processors**, driven by recorded fixtures (§4): a text message becomes a
  visible `whatsappMessage` on a thread linked to the right Person within the NFR-P2 budget.
- **Idempotency**: post the same signed payload twice concurrently → exactly one message,
  `dedup_hit` incremented.
- **Out-of-order statuses**: deliver `read` before `sent` → final status `read`, all three
  timestamps recorded.
- **Orphan status**: a status for an unknown WAMID re-enqueues, then records as orphan.
- **Media worker**: fixture media, a 404-on-first-URL path that refetches successfully, an
  oversize file that defers, and a `force` download of a deferred file.
- **Contact matching**: exact match, BR-variant match, no match → auto-create, ambiguous →
  `needs_review`, auto-creation disabled → unlinked thread.
- **Thread uniqueness**: two concurrent inbound messages from a new number produce one thread and
  one Person.
- **Send path**: policy denial returns 409 with no provider call (provider mocked); allowed send
  creates a `queued` message and schedules a job.
- **Campaign runner resumability**: snapshot 1 000 recipients, run one tick, kill mid-batch,
  re-run → zero duplicate messages, zero lost recipients, stale claims reverted.
- **`tier_waiting`**: tier limit 250, audience 400 → 225 sent (10 % reserve), campaign
  `tier_waiting`; simulate the 24 h roll → resumes and completes.
- **Guardrails**: injected failures past the threshold → auto-pause; a `red` quality webhook
  mid-run → auto-pause.
- **Pause / resume / cancel** semantics, including "cancel leaves sent recipients tracking".
- **Consent**: `STOP` inbound → `opted_out`, one confirmation only on repeat; opted-out template
  send blocked for an **admin**; a direct Person field edit produces a consent event.
- **Feed route**: `since` cursor returns only deltas; a restricted-visibility thread is absent for
  a non-assignee.
- **Roles**: for each admin route, an agent call → 403 and an anonymous call → 401.

---

## 3. Contract tests

Golden files under `src/__tests__/golden/outbound/` — one JSON per message shape, byte-compared
against the builder's output:

`text`, `text-with-context`, `image-by-id`, `document-with-filename`, `audio`, `video`, `sticker`,
`location`, `contacts`, `reaction`, `interactive-buttons`, `interactive-list`, `template-simple`,
`template-with-media-header`, `template-with-url-button`, `template-named-parameters`,
`mark-as-read`.

A change to any of these files must be a deliberate commit — that is the mechanism that catches an
accidental payload regression when someone refactors the builder.

Additionally, a **staging contract run** posts each golden payload to a Meta test number and
asserts a 2xx and a WAMID. Run before each release and after any `META_GRAPH_VERSION` bump
(§5.3 of doc 11).

---

## 4. Fixtures

`src/__tests__/fixtures/meta/` holds **real, captured** webhook payloads (redacted phone numbers),
not hand-written approximations. Required set:

| Group | Files |
|---|---|
| Inbound | text, text-with-emoji-and-accents, image, video, audio, voice-note, document, sticker, location, contacts, reaction-add, reaction-remove, reply-with-context, button-reply, list-reply, flow-reply, unsupported-order, referral-ctwa |
| Statuses | sent, delivered, read, played, failed-131047, failed-131026, failed-131049, batch-of-mixed, out-of-order, duplicate |
| Templates | status-approved, status-rejected, quality-update, category-change |
| Account | quality-green-to-yellow, quality-to-red, account-restricted, name-update |
| Malformed | empty-entry, unknown-field, missing-metadata, two-entries-two-wabas |

Each fixture ships with its correctly computed signature so the resolver can be exercised
end-to-end. Capturing them is a **week-1 task**, not a week-8 one: the fixtures unblock the whole
of workstream B.

---

## 5. Load tests

- **NFR-S2** — replay webhook fixtures at 50 deliveries/second for 60 seconds; assert zero lost
  events, zero duplicates, and ack p95 < 1 s.
- **Throttle** — drive the sender at the configured ceiling against a mock provider; assert no
  130429 and that observed spacing matches `1000/rate` within tolerance.
- **NFR-S5** — measure interactive send latency **while** a campaign is running at full campaign-
  lane rate; assert p95 ≤ 3 s (this is the test that proves the dual-cursor design, D-5).
- **10 000-recipient campaign** end-to-end against a mock provider: zero lost, zero duplicate
  recipients, correct counters, correct tier accounting.
- **NFR-S4** — snapshot 100 000 recipients; assert completion within the API budget and that
  interactive latency is unaffected during the snapshot.

---

## 6. E2E (staging, Meta test number)

The scripted loop, run before the release gate and after each Twenty upgrade:

1. Message the business number from an allowlisted device → appears in the CRM ≤ 5 s.
2. Person auto-created with the correct `+244` phone.
3. Reply free-form from the Person tab → ticks progress to delivered, then read.
4. Send an image → renders on the device; receive an image → renders in the CRM.
5. Quote-reply in both directions.
6. Force window expiry (adjust `WA_SERVICE_WINDOW_HOURS` to a small value in staging) → composer
   switches to template-only.
7. Send a template from the same thread → **no duplicate conversation is created** (the explicit
   Chatwoot #14086 regression check).
8. Send `PARAR` from the device → contact becomes `opted_out`, one confirmation received;
   a template send is then refused with a clear message.
9. Launch a 3-recipient campaign to internal test numbers → all delivered, stats correct, one
   reply marks `responded`.

Automated where the device side can be simulated; a signed manual checklist otherwise.

---

## 7. Requirement → test traceability

Legend: **U** unit · **I** integration · **C** contract · **L** load · **E** E2E.

| Req | Test |
|---|---|
| AR-1 | I: app installs and appears in `findManyApplications` |
| AR-2 | I: manifest declares the four server variables with `isSecret`; U: `requireSecret` throws when unset |
| AR-3 | CI: bundle grep finds no secret and no `graph.facebook.com` in front-component output |
| AR-4 | I: reinstall preserves records (identifiers stable) |
| AR-5 | I: post-install is idempotent across two runs |
| AR-6 | U §1.4; I: GET handshake returns the bare challenge; bad signature → 401 |
| AR-7 | I: raw event rows exist before any processor job runs |
| AR-8 | I: concurrent duplicate delivery → one record |
| AR-9 | U §1.3; I: out-of-order statuses |
| AR-10 | Runbook checklist + I: each subscribed field's fixture is handled |
| AR-11 | U: static assertion that only `wa-outbound-sender` imports `provider.sendMessage` |
| AR-12 | U §1.6 pacing; L: throttle |
| AR-13 | I: injected 429 → backoff sequence, 5 attempts, then terminal |
| AR-14 | C: media goldens use `id`, never `link` |
| AR-15 | I: media worker incl. expired-URL refetch |
| AR-16 | U: size/type validation table |
| AR-17 | U §1.1 |
| AR-18 | U: provider interface conformance test against the cloud-api implementation |
| AR-19 | L: NFR-S5 |
| AR-20 | I: runner resumability |
| AR-21 | I: `tier_waiting` and auto-resume; U: budget maths |
| AR-22 | I: breaker and quality auto-pause |
| FR-ACC-1..4 | I: connect + test call; health check transitions; E: settings panel green |
| FR-ACC-5 | I: test-account flag surfaces on the feed payload |
| FR-ACC-6 | I: two accounts, independent threads/templates/cursors |
| FR-IN-1 | I: one test per inbound fixture, including `unsupported` |
| FR-IN-2 | I: dedup; L: latency |
| FR-IN-3 | I: window refresh on inbound |
| FR-IN-4 | I: reaction attaches to target, not a new bubble; profile name captured |
| FR-IN-5 | I: unread increments; toast component emits once per message |
| FR-IN-6 | I: referral fixture → 72 h window |
| FR-OUT-1 | E step 3; I: optimistic record returned before provider completes |
| FR-OUT-2 | U §1.1; E step 6 |
| FR-OUT-3 | C `text-with-context`; E step 5 |
| FR-OUT-4 | U: error classification table; I: failed message exposes code + retry affordance |
| FR-OUT-5 | E step 7 |
| FR-OUT-6 | I: `sentBy` and timeline activity written |
| FR-OUT-7 | C interactive goldens; I: button/list replies ingested |
| FR-CID-1..2 | U §1.2 |
| FR-CID-3 | I: auto-create with ACTOR attribution; toggle off honoured |
| FR-CID-4 | I: relink keeps history |
| FR-CID-5 | I: two matches → `needs_review` |
| FR-THR-1 | I: thread uniqueness under concurrency; E step 7 |
| FR-THR-2..3 | I: transition table; assignment audited |
| FR-THR-4 | I: round-robin distributes across 3 members |
| FR-THR-5 | I: sweeper flips `windowState` |
| FR-TPL-1 | I: paginated sync, deletion → `disabled` |
| FR-TPL-2 | I: unpublished template rejected server-side for an agent |
| FR-TPL-3 | U: spec derivation + rendering |
| FR-TPL-4 | U: `assessSupport` |
| FR-TPL-5 | I: template metadata stored on the message |
| FR-TPL-6 | I: submission creates a `pending` record; hourly cap enforced |
| FR-CON-1 | I: status + event written together |
| FR-CON-2 | I: admin blocked; reply allowed |
| FR-CON-3 | I: keyword matrix, single confirmation |
| FR-CON-4 | I: workflow action denied with reason |
| FR-UI-1..3 | E: manual checklist per surface; I: feed payload completeness |
| FR-UI-4 | I: `since` cursor returns deltas only |
| FR-UI-5 | CI: no untranslated literal in front components (lint rule) |
| FR-UI-6 | E: countdown chip, quality banner, inline retry |
| FR-WF-1 | I: action sends, and denies with a reason |
| FR-WF-2 | I: `whatsappMessage.created` carries `body` and `type` (single-write rule, 09 §2) |
| FR-TL-1 | I: activities written for each catalog event, respecting `WA_TIMELINE_MODE` |
| FR-TL-2 | I: aggregate query over `whatsappMessage` returns expected counts |
| FR-CAM-1..14 | §1.6 U + §2 I as listed; L: 10 k campaign |
| SEC-1 | CI: log-redaction test + bundle grep |
| SEC-2 | U §1.4; I: 401 path has no side effects |
| SEC-4 | I: rotating the variable takes effect without redeploy |
| SEC-5 | I: role matrix per route |
| SEC-6 | I: admin cannot override opt-out |
| SEC-7 | I: restricted thread absent from a non-assignee's feed |
| SEC-8 | I: erasure removes content, leaves a tombstone |
| SEC-9 | I: purge blanks bodies, keeps counts; retention below 7 days rejected |
| SEC-10/12 | I: audit entries for each action in the 10 §5 table |
| NFR-P1..P4 | L + I latency assertions |
| NFR-R1 | I: processor failure leaves a replayable `failed` row |
| NFR-R2 | I: 429 from the Core API triggers backoff, not data loss |
| NFR-R3 | I: stuck `queued` message is recovered |
| NFR-M2 | CI: weekly compat job |

Requirements with no row here are MAY items; picking one up requires adding its row.
