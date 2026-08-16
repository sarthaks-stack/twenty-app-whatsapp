# 15 — Implementation task plan

Live status of the build against [13-delivery-plan.md](13-delivery-plan.md). Updated 2026-08-15.

**Where things stand:** the foundation and the pure domain logic are done and verified. Nothing
that talks to Meta or renders UI exists yet. In delivery-plan terms, workstream A is complete,
the pure half of B/C/D is complete, and every logic function and front component remains.

| | Done | Remaining |
|---|---|---|
| Spec documents | 20 | — |
| Objects / fields / indexes / roles | 8 / 34 / 5 / 3 | — |
| Domain modules | 13 | ~5 |
| Provider modules | 1 | ~5 |
| Server helpers | 0 | ~12 |
| Logic functions | 0 | **28** |
| Front components | 0 | 6 |
| Layout entities | 0 | ~9 |
| Unit tests | 386 | — |
| Integration / contract / E2E tests | 2 | ~40 |

Legend: **✅ done and verified** · **🔨 partially done** · **⬜ not started** · **🚫 blocked**

---

## Verification standard

A task is done when it passes the check named in its row — not when the code exists. Three
levels, in increasing strength, all of which this project has already needed:

1. `yarn typecheck && yarn lint && yarn test:unit`
2. `yarn twenty plan` against a running server, **plus** an inspection of
   `.twenty/output/manifest.json` — the build silently drops entities that are not default
   exports (specs/02 §13)
3. behaviour observed against a live Meta test number

Level 1 passing proved nothing about the data model: the first `plan` produced 90 errors.

---

## Phase 0 — Specs and tooling ✅

| # | Task | Status | Verified by |
|---|---|---|---|
| 0.1 | 20 spec documents, requirement-traced | ✅ | review |
| 0.2 | Webhook capture harness (`yarn capture`) | ✅ | live Meta deliveries captured |
| 0.3 | Fixture redaction + `yarn capture:reredact` | ✅ | `fixture-privacy.test.ts`, verified by injecting a leak |
| 0.4 | 33 recorded fixtures (15 real + 7 Meta samples + statuses) | ✅ | manifest coverage 15/15 required |
| 0.5 | HMAC verifier proven against real Meta signatures | ✅ | `captured-signatures.test.ts` |

**Outstanding from this phase:** 3 fixtures cannot be captured and must be hand-written and
marked `synthetic: true` — `inbound-text-referral`, `inbound-interactive-nfm-reply`,
`status-failed-131049`. The last drives a campaign guardrail, so that path stays synthetic-only
until production. Two more (`inbound-audio`, `status-read`) are blocked by device/account
settings, documented in `tools/webhook-capture/required-fixtures.ts`.

---

## Phase 1 — Platform foundation ✅ (workstream A)

| # | Task | Status | Requirements |
|---|---|---|---|
| 1.1 | Universal identifier registry (~55 stable UUIDs) | ✅ | AR-4 |
| 1.2 | Derived field identifiers (`fieldId`, UUID v5) | ✅ | D-11 |
| 1.3 | `application-config.ts`: 4 secrets + 24 tunables | ✅ | AR-2, SEC-1, NFR-M1 |
| 1.4 | 8 objects with all fields | ✅ | §8 |
| 1.5 | 16 relations as 32 two-sided field files | ✅ | D-11 |
| 1.6 | Person extensions (consent status + timestamp) | ✅ | FR-CON-1 |
| 1.7 | 5 composite indexes | ✅ | AR-8, NFR-P4 |
| 1.8 | Agent / Admin / function roles | ✅ | SEC-5 |
| 1.9 | Remove scaffolded placeholder page | ✅ | — |

**Verified at level 2**: applied to a live Twenty v2.31.0 and read back through the Metadata
API — 8 objects active, 260 fields, 5 Person and 4 workspaceMember extensions.

---

## Phase 2 — Domain logic ✅ (pure, no SDK)

| # | Module | Status | Requirements |
|---|---|---|---|
| 2.1 | `constants.ts` — every SELECT value, typed | ✅ | specs/02 §13 |
| 2.2 | `phone/normalise.ts` + `country-variants.ts` | ✅ | FR-CID-1, FR-CID-2 |
| 2.3 | `policy/service-window.ts` | ✅ | FR-IN-3, FR-IN-6 |
| 2.4 | `policy/send-permission.ts` — the single gate | ✅ | AR-17, FR-CON-2, SEC-6 |
| 2.5 | `status-machine.ts` | ✅ | AR-9 |
| 2.6 | `pacing.ts` — lanes, slots, backoff | ✅ | AR-12, AR-19, NFR-S5 |
| 2.7 | `campaign/exclusions.ts` | ✅ | FR-CAM-3, FR-CAM-5 |
| 2.8 | `campaign/tier-budget.ts` | ✅ | AR-21 |
| 2.9 | `campaign/guardrails.ts` — breaker, cost, pacing detection | ✅ | AR-22, FR-CAM-11 |
| 2.10 | `webhook/types.ts`, `classify-change.ts`, `redact.ts`, `sample-delivery.ts` | ✅ | D-2, specs/12 §4 |
| 2.11 | `dedup-key.ts` | ✅ | AR-8, specs/02 §8.1 |
| 2.12 | `inbound-normalise.ts` — Meta message → stored shape | ✅ | FR-IN-1, specs/03 §4.1 |
| 2.13 | `template-spec.ts` — `deriveVariableSpec`, `assessSupport` | ✅ | FR-TPL-3, FR-TPL-4 |
| 2.14 | `template-render.ts` — `{{n}}` binding, parameter sanitisation | ✅ | FR-TPL-3, FR-CAM-4 |
| 2.15 | `campaign/variable-resolution.ts` — allow-listed field paths | ✅ | FR-CAM-4, specs/06 §5 |

Phase 2 is **complete**. 2.11–2.15 landed with 115 unit tests plus a fixture-conformance suite
that replays all 33 recorded deliveries through `buildDedupKey`, `classifyChange` and
`normaliseInboundMessage` — the only kind of test that catches a field present in the
documentation and absent in reality. Three spec corrections came out of it: multi-item dedup keys
and `entry.time` (02 §8.1), the inline media URL's real 5-minute life (03 §8), and two added
unsupported-template reasons (06 §2).

---

## Phase 3 — Provider seam ✅ (AR-18, D-14)

| # | Module | Status | Notes |
|---|---|---|---|
| 3.1 | `providers/whatsapp/verify-signature.ts` | ✅ | proven against real Meta signatures |
| 3.2 | `providers/whatsapp/types.ts` — `WhatsAppProvider` interface | ✅ | appendix A §9 |
| 3.3 | `providers/whatsapp/config.ts` — `requireSecret`, fails closed | ✅ | SEC-1 |
| 3.4 | `providers/whatsapp/payload.ts` — one builder per message type | ✅ | appendix A §2 |
| 3.5 | `providers/whatsapp/errors.ts` — the appendix B catalog | ✅ | FR-OUT-4 |
| 3.6 | `providers/whatsapp/cloud-api.provider.ts` | ✅ | the only implementation |
| 3.7 | `providers/whatsapp/index.ts` — `getProvider()` | ✅ | AR-18 |
| 3.8 | Golden-file contract tests, 17 payload shapes | ✅ | specs/12 §3 |
| 3.9 | Architecture guard: no Graph host, **no `fetch(`**, no token outside `src/providers/` | ✅ | AR-11 |

Phase 3 is **complete**, with 107 tests. Two deviations worth recording:

- **3.9 is a test, not a lint rule.** oxlint ships no `no-restricted-syntax`, and the rule as
  specified was too weak anyway: the media CDN URL arrives *inside* Meta's payload, so a module
  could download from it without ever naming a host. The guard bans `fetch(` itself outside
  `src/providers/`, which is the invariant AR-11 actually wants — one HTTP layer. Verified by
  injecting a violation and watching three assertions fail.
- **An aborted mutating request is `ambiguous`, never retryable.** Meta may have accepted it, and
  a duplicate customer message is worse than a false failure. A 200 carrying no WAMID is treated
  the same way, because a record with no idempotency key can never be matched by the status
  webhooks that follow.

3.8 is what makes a payload regression a failing commit rather than a Meta error.

---

## Phase 4 — Server helpers ✅

Shared infrastructure every logic function depends on. Building these first avoids 28 handlers
inventing their own conventions.

| # | Module | Status | Requirements |
|---|---|---|---|
| 4.1 | `server/clients.ts` — memoised Core/Metadata clients | ✅ | — |
| 4.2 | `server/logger.ts` — structured, correlation id, secret redaction | ✅ | NFR-O1, SEC-1 |
| 4.3 | `server/metrics.ts` — kv counters | ✅ | NFR-O2 |
| 4.4 | `server/batching.ts` — ≤60-record chunks, adaptive backoff | ✅ | NFR-R2, C-1 |
| 4.5 | `server/config.ts` — account field → app variable → default | ✅ | NFR-M1 |
| 4.6 | `server/auth.ts` — `requireCaller`, `requireRole` | ✅ | SEC-5 |
| 4.7 | `server/repositories/*` — typed CRUD per object | ✅ | — |
| 4.8 | `server/matching.ts` — person matching, auto-create, needs-review | ✅ | FR-CID-3, FR-CID-5 |
| 4.9 | `server/threads.ts` — `upsertThread`, lifecycle, assignment | ✅ | FR-THR-1…4 |
| 4.10 | `server/consent.ts` — `setConsent` writing field + event atomically | ✅ | FR-CON-1 |
| 4.11 | `server/timeline.ts` — activity writer with `WA_TIMELINE_MODE` | ✅ | FR-TL-1, D-9 |
| 4.12 | `server/schedule.ts` — cursor read, slot assignment, `enqueueJob` | 🔨 | D-5 |
| 4.13 | `server/audit.ts` | ✅ | SEC-10, SEC-12 |

**Probe P-5 is answered: yes.** The generated schema exposes
`PhonesFilterInput.additionalPhones` as a `RawJsonFilter` with a `like` operator, so the
two-pass matcher is built as specified and the derived indexed-array fallback is **not needed**.
The `like` pass is a substring scan over serialised JSON, so it runs only when the indexed
primary-phone pass finds nothing.

Two items are not in this phase's commit:

- **4.6 `auth.ts`** landed with the first route that has a caller to check
  (`wa-account-admin-route`), which is what let its two rules be established against the running
  platform rather than guessed — see specs/10 §3.4.
- **4.12 `schedule.ts`** is partly built. `jobs.ts` covers enqueueing with a retry policy and a
  loud failure; lane cursors and slot assignment belong with the outbound sender that reads them.

Along the way this phase added a check nobody asked for and everybody needed:
`schema-enums.test.ts` compares all 19 SELECT enums in `domain/constants.ts` against the enums
the *server* generated. A renamed option or an un-applied edit typechecks perfectly and fails at
runtime on a real customer message; now it fails at `yarn test`.

---

## Phase 5 — Ingestion ✅ (verified end to end against live Meta)

| # | Function | Trigger | Status | Requirements |
|---|---|---|---|---|
| 5.1 | `wa-webhook-verify` | httpRoute GET | ✅ | AR-6, D-1 |
| 5.2 | `wa-webhook-resolver` | serverRoute | ✅ | AR-6, SEC-2, D-3 |
| 5.3 | `wa-webhook-ingest` | dispatched | ✅ | AR-7, D-2 |
| 5.4 | `wa-inbound-processor` | queued | ✅ | FR-IN-1…4 |
| 5.5 | `wa-status-processor` | queued | ✅ | AR-9, FR-CAM-9 |
| 5.6 | `wa-template-event` | queued | ✅ | FR-TPL-1 |
| 5.7 | `wa-account-event` | queued | ✅ | FR-ACC-3 |
| 5.8 | `wa-media-worker` | queued | ✅ | AR-15, D-8 |
| 5.9 | Integration tests against the 33 recorded fixtures | ✅ | specs/12 §2 |

**The loop is closed.** All eight functions are applied, and the whole recorded corpus was
replayed at the live resolver using the raw bytes and signatures Meta itself produced:

| Check | Result |
|---|---|
| Real deliveries accepted | 25/25 → `202 {queued:true}` |
| Meta dashboard samples rejected as unclaimed | 9/9 → `200`, correctly (their `entry.id` is `"0"`) |
| Webhook events | 25, **all `PROCESSED`, zero errors** |
| Messages created | 19, across 11 types |
| Threads | 1, person matched and auto-created |
| Media attached | 7/7, correct extensions from mime type |
| **Redelivery (AR-8)** | second identical POST → **1 event, 1 message, 1 thread** |

The unread count is worth its own line: 19 messages minus 3 reactions = **16**, confirming live
that a reaction does not make the inbox claim attention it does not need.

Five defects surfaced here that no unit test could have found, all now fixed and guarded:

1. **`WA_PROVIDER` drift** — the declaration said `cloud-api`, the registry knew
   `META_CLOUD_API` (D-17).
2. **`twenty-sdk/define` is stubbed in logic-function bundles**, so derived field identifiers are
   `undefined` at runtime (D-15).
3. **`uploadFile` works only on the metadata endpoint** (D-16).
4. **Meta reports `sha256` in base64 on the webhook and hex from `GET /{media_id}`** — the
   integrity check rejected every correctly-downloaded file (appendix A §3).
5. **The function role needs `UPLOAD_FILE` / `DOWNLOAD_FILE`**, which fail with a message naming
   neither the permission nor the file (specs/10 §3.1).

Each is now covered by a test that reproduces the original failure.


---

## Phase 6 — Outbound ✅

| # | Function | Trigger | Status | Requirements |
|---|---|---|---|---|
| 6.1 | `wa-outbound-sender` — the only caller of `POST /messages` | queued | ✅ | AR-11…14 |
| 6.2 | `wa-send-message-route` | httpRoute POST | ✅ | FR-OUT-1…3 |
| 6.3 | `wa-thread-actions-route` — assign, close, relink, mark read | httpRoute POST | ✅ | FR-THR-3, FR-CID-4 |
| 6.4 | `wa-window-sweeper` | cron 15 min | ✅ | FR-THR-5 |
| 6.5 | `wa-health-check` | cron hourly | ✅ | FR-ACC-4, NFR-R3 |
| 6.6 | Integration tests: policy denial, retry, crash recovery | ✅ | specs/12 §2 |

**~5 days.** 6.1 carries the `UNKNOWN_ACCEPTANCE` rule — never retry an ambiguous outcome, since
a duplicate customer message is worse than a false failure.

Supporting modules built alongside: `src/server/schedule.ts` (dual-cursor pacing),
`src/server/files.ts` (the one HTTP exception, D-18), `src/domain/media-limits.ts` (AR-16),
`src/server/repositories/campaigns.ts` (the slice the sender needs to pause a run).

**Verified live, without sending a message.** Auth rejection, body validation, unknown thread and
unknown template, a `409` policy denial that created no record, every thread action, and
`clientToken` idempotency returning the existing message rather than queueing a second.

The `*/15` cron was observed firing: a throwaway thread with an expired window flipped to
`EXPIRED` at 23:30:00Z, which is the only way to know a cron trigger is wired rather than merely
declared. `wa-health-check` is registered on the same mechanism at `0 * * * *`.

What remains unexercised is a real Meta send — the call itself, and the `accepted → sent →
delivered` chain that follows it. Everything up to `provider.sendMessage` is covered. See
specs/04 §10.

---

## Phase 7 — Templates and consent ✅

| # | Function / module | Status | Requirements |
|---|---|---|---|
| 7.1 | `wa-template-sync` — paginated, deletion detection | ✅ | FR-TPL-1 |
| 7.2 | `wa-template-submit` — with the 90/hour local cap | ✅ | FR-TPL-6 |
| 7.3 | `wa-consent-route` — set, import, erase | ✅ | FR-CON-1, SEC-8 |
| 7.4 | `wa-consent-keyword` — one confirmation only | ✅ | FR-CON-3 |
| 7.5 | Person `updated` trigger back-filling manual consent edits | ✅ | specs/06 §11 |

**~4 days.** Supporting modules: `src/server/outbound.ts` (the shared queue-and-schedule step,
now used by the composer and the keyword handler), `src/server/erasure.ts` (SEC-8), and
`src/domain/send-spec.ts` (the send spec moved out of the sender so the server can queue without
importing from a logic function).

**Verified live.** The template catalogue synced from the real WABA — 5 templates over 2 pages,
variable specs derived correctly from Meta's own component arrays (an `IMAGE` header with six body
variables and a URL button read as seven), all left `publishedToCrm: false` because publishing is
a human act. A second pass reported `created: 0, updated: 5, disappeared: 0`, so the deletion
detector does not fire on a healthy catalogue. Submission validation refuses a bad name and
missing examples before touching Meta.

Consent was exercised on throwaway contacts, then erased by the routine under test: idempotent
`set` (the second identical call reported `changed: false`, which is what suppresses the second
confirmation), the `person.updated` trigger back-filling a hand-edited field with the correct
`OPTED_IN → OPTED_OUT` transition, no duplicate event from `setConsent`'s own write, a dry run
that counted 1 thread / 3 messages / 1 event and deleted nothing, and a real erasure leaving a
single tombstone with no wording, no status and the counts.

Not exercised: submitting a real template to Meta, which creates a permanent artefact in the WABA
awaiting review.

---

## Phase 8 — Campaigns ✅

| # | Function | Trigger | Status | Requirements |
|---|---|---|---|---|
| 8.1 | `wa-campaign-control` — create, update, build, preview, preflight, testSend, launch, pause, resume, cancel | httpRoute | ✅ | FR-CAM-8, SEC-12 |
| 8.2 | `wa-campaign-snapshot` — self-requeuing, duplicates read from the rows | queued | ✅ | FR-CAM-2/3, NFR-S4 |
| 8.3 | `wa-campaign-runner` — claim, queue, stale-claim sweep | cron 1 min | ✅ | AR-20, AR-21 |
| 8.4 | `wa-stats-rollup` — funnel recomputed, `kv` delta as the change hint | cron 1 min | ✅ | FR-CAM-10 |
| 8.5 | Saved-view audience translation (`domain/campaign/view-filter.ts`) | — | ✅ | FR-CAM-2a, D-23 |
| 8.6 | Tier ledger (`server/tier-ledger.ts`), written after acceptance | — | 🔨 unit only | AR-21 |
| 8.7 | Integration: exclusions, cancel semantics, terminal refusals, view refusal | ✅ | specs/12 §2 |

**Verified at level 3** against a live Twenty and the connected WABA, arranged so nothing was
sent: the workspace finished with zero outbound messages. The full record is in
[07 §14.8](07-campaigns.md#148-live-verification-2026-08-16).

Two findings that only a live run could produce:

- **A campaign thread did not carry the person the campaign chose** ([D-22](00-architecture-decisions.md#d-22--a-campaign-thread-carries-the-person-the-campaign-chose)).
  The sender reads consent through `thread.personId`; with no link it read `UNKNOWN`. A utility
  campaign would have ignored an opt-out that arrived while its message was queued.
- **The rollup was never told about a send that failed before Meta** (07 §14.2). A campaign whose
  whole batch was denied by policy reported `failedCount: 0`.

**Still unproven: anything downstream of a real Meta acceptance** — 8.6's increment,
`pacingObserved`, the failure-rate breaker, and the delivered/read funnel. Each is unit tested and
none has met Meta. One campaign to a number the business is willing to message closes all four.

`tier_waiting` and resumability were exercised through their unit tests and the state machine
only; reaching them live needs an account at its tier ceiling.

---

## Phase 9 — Front components ⬜ 🚫

| # | Component | Status | Requirements |
|---|---|---|---|
| 9.0 | **Probe P-6** — `column-reverse` anchoring in the sandbox, 200-message list, `twenty-ui` in a record widget | 🚫 **blocks 9.2–9.7** | D-7, R-3 |
| 9.1 | `wa-inbox-feed-route` — the single aggregated data path | ⬜ | D-6, FR-UI-4 |
| 9.2 | `useFeed` hook, theming, i18n scaffolding | ⬜ | D-6 |
| 9.3 | `<ThreadView>` — list, bubbles, ticks, media, day separators | ⬜ | FR-UI-1 |
| 9.4 | Composer with policy-driven states | ⬜ | FR-OUT-1/2 |
| 9.5 | Template picker + variable form | ⬜ | FR-TPL-3 |
| 9.6 | Person tab, side panel, command menu item | ⬜ | FR-UI-1/3 |
| 9.7 | Inbox page + headless toaster | ⬜ | FR-UI-2, D-10 |
| 9.8 | Campaigns page — list, builder, pre-flight, detail | ⬜ | FR-CAM-1/6/10 |
| 9.9 | Settings — connection, callback card, health, templates, consent, diagnostics | ⬜ | FR-ACC-1…5, NFR-O3 |
| 9.10 | Page layouts, tabs, nav items, views | ⬜ | FR-UI-1/2 |
| 9.11 | pt-PT / en catalogs | ⬜ | FR-UI-5 |

**~15 days, the largest and least certain phase.** P-6 has not run; if it fails, UI tiers 2/3
(08 §10) change the presentation without touching any server contract.

---

## Phase 10 — Automation, ops, release ⬜

| # | Task | Status | Requirements |
|---|---|---|---|
| 10.1 | `wa-send-template-action` workflow action | ⬜ | FR-WF-1 |
| 10.2 | `wa-account-admin-route` — connect, test, disconnect, kv claim | ✅ | FR-ACC-1, D-3 |
| 10.3 | `wa-webhook-replay-route` | ⬜ | §12.4 |
| 10.4 | `wa-retention-purge` | ⬜ | SEC-9 |
| 10.5 | `post-install` / `uninstall` hooks | ⬜ | AR-5 |
| 10.6 | Default notification workflow provisioning | ⬜ | D-10 layer 3 |
| 10.7 | Weekly compat CI against `twentycrm/twenty:latest` | ⬜ | NFR-M2, R-2 |
| 10.8 | Load tests: burst, throttle, NFR-S5, 10k campaign | ⬜ | specs/12 §5 |
| 10.9 | E2E on the production number | ⬜ | specs/12 §6 |
| 10.10 | Security review: role matrix, consent block, secret scan | ⬜ | specs/12 Security |
| 10.11 | Runbook rehearsal by ops | ⬜ | §12.2 |

**~8 days.**

---

## Remaining probes

Only P-1 has been answered. The rest still gate design decisions:

| Probe | Question | Blocks | Fallback |
|---|---|---|---|
| **P-1** | Does Meta accept our GET handshake? | — | ✅ **passed** against real Meta |
| P-2 | Rate limit on `/s/*` routes | 9.1 polling intervals | raise intervals to 10 s |
| P-3 | Can the app role write `timelineActivity`? | 4.11 | downgrade FR-TL-1 to the WhatsApp tab |
| P-4 | Does a soft-deleted row hold a unique index? | 10.4 | purge hard-destroys. *No longer gates campaigns: the snapshot upserts, so either answer is correct* |
| P-5 | Can the Core API filter `additionalPhones`? | 4.8 | derived indexed array field |
| P-6 | Front-component chat feasibility | 9.2–9.7 | UI tiers 2/3 |
| P-7 | Row-level permission predicates | SEC-7 enforcement | route-level filtering, limitation documented |
| P-8 | Does `cronTriggerSettings.pattern` accept a six-field (seconds) pattern? | 07 §10's 30 s freshness | one-minute ticks, ≤ 60 s freshness (as built) |

---

## Critical path

```
Phase 2 tail (2d) → Phase 3 (3d) → Phase 4 (5d) → Phase 5 (6d) ── first observable loop
                                                      ↓
                                        Phase 6 ✅ → Phase 7 ✅ → Phase 8 ✅
                                                      ↓
                              Phase 9 (15d, P-6 gated) → Phase 10 (8d) → release gate
```

**~23 working days of engineering remaining** — phase 9 (15d) and phase 10 (8d) — or roughly 5
weeks for one engineer. Phases 0–8 are done, which is the whole server side: every object, every
logic function that talks to Meta or to the CRM, and the campaign pipeline. What is left is the
user interface and the operational tail.

Phase 9 is the schedule risk: it is the largest block, it is gated on an unrun probe, and Twenty
documents front components as "under active development".

---

## Ordering advice

1. **Finish phase 2 before starting logic functions.** Pure modules are 20× cheaper to test.
2. **Phase 3 and 4 before phase 5.** Twenty-eight handlers sharing conventions beats 28
   handlers inventing them.
3. **Run P-6 now, in parallel.** It is the only probe that can invalidate a whole phase, and it
   needs no other work to finish first.
4. **Phase 5 before phase 6** — the fixtures already exist, so ingestion is testable today while
   outbound needs the provider and a test number.
5. **Do not start phase 9 without P-6.**

---

## Non-goals for this build

Carried from the TRD, restated so they do not creep in: WhatsApp Groups, Flows authoring,
commerce catalogs, voice calling, BSP drivers, unofficial gateways, forking Twenty core, and
Twenty Cloud distribution. The MAY items (FR-UI-7 desktop notifications, FR-TL-3 dashboard,
FR-CAM-14 export/duplication, FR-WF-3 free-form action) are picked up only if capacity allows,
each with its own go/no-go.
