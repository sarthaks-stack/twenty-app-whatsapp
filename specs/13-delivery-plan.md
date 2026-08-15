# 13 — Delivery plan

Implements TRD §14. Single release: all MUST and SHOULD requirements ship together; MAY items are
picked up only if capacity allows and each carries an explicit go/no-go.

Indicative effort: **12–16 weeks with 2–3 engineers**, workstreams parallelised, one integration
point and one release gate.

---

## 1. Week-1 de-risking probes

These run **before** the workstreams commit to their designs, and every one has a specified
fallback so a failed probe changes the plan, never blocks it. Owner: the platform-foundation
engineer. Time-box: 5 days total, all seven.

| # | Probe | Question | Fallback if it fails | Spec |
|---|---|---|---|---|
| **P-1** | Server-route GET | Does `/webhooks/server/{uuid}` accept GET, and is a `Response` body returned verbatim? | Reverse-proxy method split + `/s/whatsapp/verify` HTTP route (already specified and built regardless) | D-1 |
| **P-2** | Rate limits on `/s/*` | What request rate do app HTTP routes actually permit for a workspace token? | Raise polling intervals; use the self-hosted rate-limit env var | D-6 |
| **P-3** | `timelineActivity` writes | Can the app role create timeline activities? | Downgrade FR-TL-1 to the WhatsApp tab as the history surface | D-9 |
| **P-4** | Unique index vs soft delete | Does a soft-deleted row still occupy a unique index? | Retention purge hard-destroys; ingest treats the conflict as `skipped_duplicate` | D-12 |
| **P-5** | `additionalPhones` filtering | Can the Core API filter inside the `PHONES` composite's additional entries? | Derived indexed `whatsappSearchablePhones` ARRAY on Person, maintained by a DB-event function | 05 §2.1 |
| **P-6** | Front-component chat feasibility | Does `column-reverse` scroll anchoring behave in the Remote DOM sandbox? Does a 200-message list stay responsive? Do `twenty-ui` components render in a record-page widget? | UI tiers 2/3 (08 §10) | D-7, 08 §10 |
| **P-7** | Row-level permissions | Can a role predicate express "assignee = me OR assignee is null"? | Route-level filtering, with the API-access limitation documented | 10 §3.5 |

Also week 1, and equally blocking: **capture the Meta webhook fixtures** (12 §4) from a Meta test
number. Workstream B cannot start honestly without them.

> **Built and verified ahead of week 1.** The capture harness exists at
> [`tools/webhook-capture/`](../tools/webhook-capture/README.md) — `yarn capture` behind a
> tunnel. It answers P-1, records the fixture set against a live coverage checklist, and runs the
> production `verifyMetaSignature` over every delivery, so a capture session doubles as the
> HMAC conformance test. Probe P-1 and the fixture task now need only Meta access (Q-16), not
> engineering time.

Two external clocks start on day 1 and belong to Ops, not engineering:

- **Meta business verification** (R-10) — until it completes, the portfolio is capped at 250
  business-initiated users/24 h, which directly caps campaign capacity at go-live.
- **Display-name review**, and a Meta **test WABA + number** for engineering.

---

## 2. Workstreams

Six streams, run in parallel after week 1. Dependencies are on *interfaces*, not on completion —
each stream publishes its module signatures in week 2 so the others can code against them.

### A — Platform foundation (1 engineer, weeks 1–4, then support)

| # | Task | Requirements |
|---|---|---|
| A1 | Scaffold: constants, config, roles, lint layering rules, CI | AR-1, AR-5, NFR-M2 |
| A2 | Run probes P-1…P-7; publish findings | — |
| A3 | Objects, fields (32 relation files), indexes, Person extensions | §8 of the TRD, D-11 |
| A4 | `application-config.ts` with server + application variables | AR-2, SEC-1 |
| A5 | Resolver + verify route + HMAC + kv claims | AR-6, D-1, D-3, SEC-2 |
| A6 | Ingest fan-out + raw event log + dedup keys | AR-7, AR-8, D-2 |
| A7 | Provider module skeleton + error catalog + logger/metrics/batching helpers | AR-18, NFR-O1/O2 |
| A8 | Install/uninstall hooks | AR-5 |

### B — Messaging core (1–2 engineers, weeks 2–9)

| # | Task | Requirements |
|---|---|---|
| B1 | Phone normalisation + country variants (pure + tests) | FR-CID-1/2 |
| B2 | Matching, auto-creation, needs-review, relink | FR-CID-3/4/5 |
| B3 | Thread upsert, lifecycle, assignment, sweeper | FR-THR-1…5 |
| B4 | Policy module (window, consent, template rules) | AR-17, FR-OUT-2 |
| B5 | Inbound processor: all message types + normalisation table | FR-IN-1…4/6 |
| B6 | Status processor + state machine + counter coalescing | AR-9, NFR-R2 |
| B7 | Pacing/scheduling + outbound sender + retry + error classification | AR-11/12/13, FR-OUT-1…6 |
| B8 | Media worker (in + out), size ceiling, deferred download | AR-14/15/16, D-8 |
| B9 | Send route + thread actions route + feed route | FR-OUT-1, FR-UI-4, D-6 |

### C — Templates & consent (1 engineer, weeks 3–8)

C1 template sync + pagination + deletion detection · C2 `variableSpec`/`assessSupport` ·
C3 publishing gate + admin UI hooks · C4 template webhooks + auto-unpublish ·
C5 template submission (FR-TPL-6) · C6 consent model + `setConsent` + timeline ·
C7 keyword handling + single confirmation · C8 consent import + manual-edit backfill.

### D — Campaigns (1 engineer, weeks 6–13; needs B4, B7, C1–C3, C6)

D1 objects + control route + state machine · D2 snapshot with self-requeue + exclusions +
duplicate kv set · D3 variable resolution + preview · D4 pre-flight (cost, tier, quality) ·
D5 runner + claiming + stale-claim sweeper · D6 tier ledger + `tier_waiting` + auto-resume ·
D7 circuit breaker + quality auto-pause + pacing detection · D8 stats rollup + live counters ·
D9 test send, replies/`responded`, cancel semantics.

### E — UI surfaces (1 engineer, weeks 2–14; earliest start, longest tail)

E1 `useFeed` + shared primitives + theming + i18n scaffolding · E2 `<ThreadView>`: list,
bubbles, ticks, media, day separators (the P-6 design) · E3 composer + window states + policy
rendering + attachments · E4 template picker + variable form + preview · E5 Person tab + side
panel + command menu item · E6 Inbox page with filters, badges, banners, headless toast ·
E7 Campaigns page: list, builder wizard, pre-flight, detail, controls · E8 Settings: connection,
callback card, health panel, templates, consent, diagnostics · E9 pt/en catalogs and review.

### F — Automation & ops (0.5 engineer, weeks 5–14)

F1 workflow action + output contract · F2 DB-event trigger documentation + default notification
workflow provisioning · F3 timeline writer + modes · F4 health check + alerting · F5 replay
tooling · F6 retention purge + erasure · F7 runbook, reverse-proxy configs, backup guidance ·
F8 multi-account support end-to-end · F9 load-test harness and the NFR-S5 measurement.

---

## 3. Sequencing and integration points

```
wk 1   A1 A2 (probes) + fixtures ─────────────────────────────────────────────
wk 2-4 A3-A8 │ B1-B4 │ C1-C2 │ E1-E2
wk 5-8       │ B5-B8 │ C3-C7 │ E3-E5 │ F1-F4
wk 6-10      │ B9    │ C8    │ E6    │ D1-D4
wk 9-13                        │ E7-E8 │ D5-D9 │ F5-F8
wk 13-14  INTEGRATION: full E2E, load tests, security review, runbook rehearsal
wk 15-16  Hardening, release gate, go-live
```

Three integration checkpoints, each a working demo rather than a status report:

- **End of week 4** — a signed webhook produces a visible record; the schema is complete. If this
  slips, everything slips.
- **End of week 8** — the full 1:1 loop works on the Meta test number from the Person tab.
- **End of week 12** — a 500-recipient campaign completes against internal numbers.

---

## 4. Risks specific to this plan

| Risk | Signal | Response |
|---|---|---|
| P-6 fails late (chat UX unworkable) | E2 slipping past week 6 | Drop to UI tier 2 immediately; the server contract is unaffected, so B and D continue |
| Fixtures unavailable in week 1 (Meta test number delayed) | no test WABA by day 3 | Hand-write fixtures from the documented shapes to unblock, then replace with captures — but flag every hand-written one, because they are the ones that will be subtly wrong |
| Business verification drags past week 12 | Ops status | Go live anyway: 1:1 messaging is unaffected by the tier cap; campaigns launch at 250/day with the multi-day spread already built (AR-21). Do not delay the release for it |
| Twenty weekly release breaks a surface | compat job red | Production stays pinned; fix forward against the failing version before upgrading |
| D blocked on C/B interfaces | week-6 checkpoint | The interfaces are published in week 2 specifically so D can code against mocks |

---

## 5. Release gate

Go-live requires **all** of:

1. Every MUST and SHOULD requirement green in the §7 traceability matrix of
   [12-testing.md](12-testing.md). SHOULD deferrals require written stakeholder sign-off against a
   documented blocker (TRD §7 rule).
2. The E2E loop demonstrated on the **production** number: inbound → reply → media both ways →
   window expiry → template send in the same thread → opt-out → refused template.
3. A **≥500-recipient campaign** executed against an internal/test audience with zero lost and
   zero duplicate sends, correct tier accounting, and correct stats.
4. Load: NFR-S2 burst passed; NFR-S5 measured (interactive p95 ≤ 3 s during a running campaign).
5. Security checklist passed: role matrix, consent hard-block, secret-leak scan, signature bypass
   attempts, erasure and retention verified.
6. Runbook (11 §5) rehearsed end-to-end by Ops on a clean instance, including token rotation and a
   webhook replay.
7. Q-1 (rate card), Q-2 (verification status), Q-4 (retention/legal) answered — these three gate
   go-live because they change user-visible behaviour or legal exposure.
8. The pinned Twenty version recorded, and the weekly compat job green against it.

---

## 6. Post-release

Not part of this delivery, tracked as follow-ups:

- **Campaign duplication to non-responders** (07 §12) — highest value, lowest cost of the MAY set.
- **Per-template analytics** (FR-TPL-7) — the fields already exist.
- **Response-time metric** (09 §5) — one derived field.
- **Native messaging convergence** (R-1) — when Twenty ships its messaging abstraction, evaluate
  migrating behind the provider seam (D-14). The data is in ordinary objects and is exportable,
  which is what makes this an operational decision rather than a rewrite.
- **Embedded Signup** (FR-ACC-7) — only if the app is productised for third parties (TRD §12.5).
