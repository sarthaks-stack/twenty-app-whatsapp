# 07 — Marketing campaigns (bulk sender)

Implements FR-CAM-1 … FR-CAM-14, AR-19 … AR-22, SEC-12, NFR-S4, NFR-S5.
Depends on the outbound pipeline (04) and consent (06) being complete — this is workstream D's
only hard dependency.

```
 draft ──build──► snapshotting ──► ready ──confirm──► scheduled ──► running ⇄ paused
                                     │                                │  ⇅
                                     └──── cancelled ◄────────────────┤  tier_waiting
                                                                      └──► completed / failed
```

---

## 1. Campaign states

| State | Meaning | Entered by | Leaves to |
|---|---|---|---|
| `draft` | Being built; nothing materialised | creation | `snapshotting`, `cancelled` |
| `snapshotting` | Audience being written to recipient rows | "Build audience" | `ready`, `failed` |
| `ready` | Snapshot complete, pre-flight shown, awaiting confirmation | snapshot finishes | `scheduled`, `draft` (rebuild), `cancelled` |
| `scheduled` | Confirmed; waiting for `scheduledAt` | explicit confirm (FR-CAM-6) | `running`, `cancelled` |
| `running` | Runner is claiming and sending | schedule due / resume | `paused`, `tier_waiting`, `completed`, `failed` |
| `paused` | Stopped by a human or a guardrail | control action / AR-22 | `running`, `cancelled` |
| `tier_waiting` | Daily tier budget exhausted; auto-resumes | runner (AR-21) | `running` |
| `completed` | No `pending` recipients remain | runner | — |
| `cancelled` | Stopped; unsent recipients abandoned | control action | — |
| `failed` | Unrecoverable (template deleted, account error) | runner | `paused` after admin fix |

`snapshotting` and `ready` are additions to the TRD's list; the rationale is in
[02-data-model.md §6](02-data-model.md#6-whatsappcampaign--obj_campaign).

Every transition is written by exactly one function (`wa-campaign-control` for human actions,
`wa-campaign-runner` for machine actions) through a shared `transition()` helper that validates
the edge, writes `statusReason`, and emits a timeline/audit entry (SEC-12).

---

## 2. Builder (FR-CAM-1)

Four steps in the Campaigns page front component, each persisted to the draft so a reload never
loses work.

1. **Basics** — name, sending account, schedule (now / date-time, `Africa/Luanda` default,
   stored UTC).
2. **Template** — picker restricted to `approved + publishedToCrm + isUsableInCrm`, category
   `marketing` or `utility` (FR-CAM-1). Authentication templates are excluded outright: they are
   OTP-shaped and have no bulk use case.
3. **Audience** — one of:
   - **View** — pick a saved Twenty view on Person; evaluated at snapshot time (FR-CAM-2a).
   - **Message list** — pick a `messageList` (D-13), read through `messageListMember`.
   - **Manual** — multi-select of People (FR-CAM-2b).
4. **Variables** — one binding row per `{{n}}` (06 §4/§5), with per-variable fallback text
   (FR-CAM-4), plus a live rendered preview of the **first 5 resolved recipients** — which
   requires a sampling call, `POST /s/whatsapp/campaign { action: 'preview', campaignId }`,
   returning 5 fully rendered messages.

"Build audience" then moves the campaign to `snapshotting`.

Only *WhatsApp Admin* may create, build, launch, pause, resume, cancel or delete an unlaunched
campaign (SEC-12). Agents see campaigns read-only.

---

## 3. Audience snapshot (`wa-campaign-snapshot`) — FR-CAM-2, FR-CAM-3

`timeoutSeconds: 120`, **self-requeuing** so audience size never meets the timeout ceiling
(C-2, NFR-S4).

```
input: { campaignId, cursor?, stats? }

 1. campaign = load(); assert status === 'snapshotting'
 2. page = readAudiencePage(campaign.audienceDefinition, cursor, PAGE = 500)
 3. for each person in page:
       decision = evaluateExclusions(person, campaign, seenPhones)      # §3.1, pure
       create whatsappCampaignRecipient {
         campaign, person,
         status: decision.excluded ? 'excluded' : 'pending',
         exclusionReason: decision.reason,
         resolvedPhone: decision.phone,
         resolvedParameters: decision.excluded ? null : decision.parameters
       }                                                                # batched ≤60 per call
       on unique violation (campaign, person) -> skip (idempotent re-run)
 4. accumulate stats { total, excluded by reason }
 5. if page.hasMore:
       enqueueJob(self, { campaignId, cursor: page.nextCursor, stats }, { delayMs: 1000 })
    else:
       patch campaign { recipientCount, excludedCount, exclusionBreakdown,
                        estimatedCostUsd, status: 'ready' }
```

`seenPhones` (the duplicate detector) cannot live in memory across self-requeues. It is a
`kv` set under `wa:campaign-seen:{campaignId}` holding the canonical E.164 of every accepted
recipient, deleted when the campaign reaches a terminal state. Duplicate detection is therefore
"first occurrence in scan order wins", exactly as FR-CAM-3 requires.

**Throughput** (NFR-S4): 60 records per Core API call under a 100 req/min budget ≈ 6 000
records/min, so 100 000 recipients ≈ 17 minutes. The builder shows a live progress bar reading
`recipientCount` — which is precisely why `snapshotting` had to become a real state.

The 1-second `delayMs` between pages is a deliberate throttle leaving API headroom for
interactive traffic while a large snapshot runs.

### 3.1 Exclusion matrix (`src/domain/campaign-exclusions.ts`) — FR-CAM-3, FR-CAM-5

Evaluated in this order; the first match wins and is recorded on the recipient row:

| # | Reason | Condition |
|---|---|---|
| 1 | `opted_out` | `person.whatsappOptInStatus === 'opted_out'` |
| 2 | `no_consent` | marketing category **and** status !== `opted_in` (i.e. `unknown` is excluded — FR-CAM-5, no override) |
| 3 | `invalid_phone` | no phone, or `toE164()` returns null |
| 4 | `duplicate` | canonical E.164 already seen in this audience |
| 5 | `blocked` | an existing thread for this number has `isBlocked` |
| 6 | `missing_variables` | any required `{{n}}` resolves empty **and** has no fallback |

Rule 2 is category-dependent: a **utility** campaign (permitted by FR-CAM-1) excludes only
`opted_out`, because utility templates are transactional and do not require marketing opt-in.
This distinction is encoded in the pure function and is one of the highest-value unit tests in
the suite.

Excluded recipients are **kept as rows**, not dropped. That is what makes the exclusion breakdown
auditable ("show me the 412 people we skipped and why") and what lets a re-run after a consent
campaign pick them up.

---

## 4. Variable resolution

```ts
resolveParameters(person, mapping, account, now): { ok: true; parameters } | { ok: false; missing: number[] }
```

- Each binding resolves through the §5 allow-list of `06-templates-and-consent.md`.
- Empty/whitespace result → use `fallback` if present; otherwise the recipient is excluded with
  `missing_variables`.
- Results are sanitised for Meta's parameter rules (no newlines, tabs, or >4 consecutive spaces)
  and truncated to the template's per-parameter limit.
- The resolved values are stored on the recipient row **at snapshot time**. A send or a retry
  reuses them verbatim, so editing a Person mid-campaign cannot change what a half-sent campaign
  says — the audience and its content are one immutable snapshot (FR-CAM-2).

---

## 5. Pre-flight (FR-CAM-6)

Shown when the campaign reaches `ready`; computed by
`POST /s/whatsapp/campaign { action: 'preflight' }`.

| Panel | Content | Source |
|---|---|---|
| Recipients | final count + exclusion breakdown by reason, each expandable to a sample of 10 | `recipientCount`, `exclusionBreakdown` |
| Cost | `recipientCount × rate(category)` in USD, labelled *estimated, billed on delivery* | `src/domain/cost.ts`, rates from application variables (Q-1) |
| Tier | current tier limit, unique users already consumed in the rolling 24 h, remaining after the 10 % reserve, and the **projected multi-day spread** if the audience exceeds it | `src/domain/tier-budget.ts` |
| Quality | current `qualityRating` with an explanation | `whatsappAccount` |
| Template | rendered preview with the first recipient's real values | `variableMapping` |

Launch button behaviour:

- `qualityRating === 'red'` → **blocked**, with the reason and a link to Meta's Business Support
  Home.
- `qualityRating === 'yellow'` → allowed after an explicit "I understand" confirmation.
- Otherwise → allowed, behind `openCommandConfirmationModal` stating the count and the cost.

Projected spread example rendered to the admin, using the R-10 scenario verbatim:
*"1 000 recipients · your current tier allows 250 business-initiated users/24 h · 225 will send
today (10 % held back for 1:1 messages), completing in 4 days."*

---

## 6. Runner (`wa-campaign-runner`) — AR-19, AR-20, FR-CAM-7

`cronTriggerSettings: { pattern: '* * * * *' }` (every minute) · `timeoutSeconds: 120`.
A chunked, resumable state machine. One tick, one campaign batch:

```
 1. start scheduled campaigns: status='scheduled' AND scheduledAt <= now -> 'running', startedAt=now
 2. resume tier_waiting campaigns whose tier budget has refreshed
 3. for each campaign in status 'running' (oldest lastRunTickAt first, max 3 per tick):
      a. guard: account.status === 'connected'          else pause('account_error')
      b. guard: template still approved+usable          else fail('template_unavailable')
      c. guard: account.qualityRating !== 'red'         else pause('quality_red')          # AR-22
      d. guard: failureRate(last N) <= maxFailureRatePct else pause('circuit_breaker')     # AR-22
      e. budget = tierBudget(account)                                                      # §7
         if budget.available <= 0 -> transition('tier_waiting'); continue
      f. batchSize = min(WA_CAMPAIGN_BATCH_SIZE, budget.available, remainingPending)
      g. claim: recipients where campaign=X and status='pending' order by id limit batchSize
                patch each -> status='claimed', claimedAt=now      (batched ≤60)
      h. for each claimed recipient:
                thread   = upsertThread(account, waIdFor(recipient.resolvedPhone))
                message  = createQueuedMessage(thread, template, recipient.resolvedParameters,
                                               lane:'campaign', sourceKind:'campaign')
                patch recipient { thread, message, status:'queued' }
         scheduleSend(messages, 'campaign', account)                                        # 04 §4
      i. patch campaign { queuedCount += n, lastRunTickAt: now }
      j. if no pending recipients remain and no in-flight -> 'completed', completedAt=now
```

### 6.1 Why claiming is safe (AR-20 — "no recipient is ever sent twice")

Three independent guarantees, so no single failure can duplicate a send:

1. **Claim before act.** A recipient moves `pending → claimed` before any message is created.
   The claim query only selects `pending`, so a second tick cannot re-claim it.
2. **Unique (campaign, person).** Even a duplicated snapshot cannot create two rows.
3. **WAMID uniqueness.** Even a duplicated send cannot create two message records.

A crash between (g) and (h) leaves recipients `claimed` with no message — the recoverable case.
A stale-claim sweeper inside the same runner reverts `claimed` rows older than 10 minutes with no
`message` back to `pending`. That is the only path that "loses at most the in-flight batch", and
it re-claims idempotently as AR-20 requires.

### 6.2 Concurrency

The runner processes at most 3 campaigns per tick and never two ticks of the same campaign
concurrently — enforced by `lastRunTickAt` (a campaign ticked within the last 30 seconds is
skipped). Combined with the campaign lane's single-writer cursor (D-5), this makes campaign
pacing exact rather than approximate.

---

## 7. Tier budget ledger (`src/domain/tier-budget.ts`) — AR-21

Meta's messaging limit counts **unique users messaged business-initiated in a rolling 24 h**, from
*all* sources — campaigns, workflow template sends and rep-initiated templates alike.

```ts
tierBudget(account) => {
  limit:      TIER_LIMITS[account.messagingLimitTier],       // 250 | 1000 | 2000 | 10000 | 100000 | Infinity
  used:       account.tierUniqueUsersUsed,
  reserve:    ceil(limit * WA_CAMPAIGN_TIER_RESERVE_PCT / 100),
  available:  max(0, limit - used - reserve),
}
```

**Counting.** `tierUniqueUsersUsed` is incremented by the outbound sender whenever it accepts a
**business-initiated** message (template outside a window, or any marketing template) to a
`waId` not already counted in the current window. Uniqueness within the window is tracked in
`kv` (`wa:tier:{accountId}:{yyyymmddhh-window}` → set of waIds); the counter field is the
queryable projection.

**Window.** `tierWindowStartedAt` is a rolling 24 h anchor reset by `wa-health-check` when it
ages past 24 h, at which point `tierUniqueUsersUsed` resets to 0 and every `tier_waiting`
campaign becomes eligible again (FR-CAM-7 "auto-resuming next cycle").

**Reconciliation.** `wa-health-check` reads
`GET /{phone_number_id}?fields=quality_rating,messaging_limit_tier,throughput` hourly and
corrects `messagingLimitTier`. Our count is an estimate — Meta's tier is the truth — so when
Meta reports a tier change, the ledger recomputes `available` immediately rather than waiting for
the next window.

The reserve (default 10 %) is what stops a campaign from consuming the whole daily allowance and
leaving a rep unable to send a template to a customer at 4 pm.

---

## 8. Guardrails (AR-22, FR-CAM-11)

| Guardrail | Trigger | Action |
|---|---|---|
| Failure-rate breaker | over the last `WA_CAMPAIGN_FAILURE_WINDOW` (100) terminal outcomes, `failed / (failed + sent) > maxFailureRatePct` | `paused`, `statusReason='circuit_breaker'`, admin alert |
| Quality downgrade | `phone_number_quality_update` → `red` | all running campaigns on the account `paused`, `statusReason='quality_red'` (03 §7) |
| Template revoked | template leaves `approved` | `failed`, `statusReason='template_unavailable'` |
| Account error | token invalid / account restricted | `paused`, `statusReason='account_error'` |
| Marketing pacing | ≥ 20 % of a batch's sends return no `sent` status within 15 minutes, with no errors | **not** an error: set `pacingObserved = true` and show "Meta is pacing delivery of this campaign to gather early engagement signals — this is normal for large marketing sends" (R-12) |
| 131049 per-user cap | Meta's marketing frequency cap | recipient `skipped`, counted separately, **never retried** (appendix B) |

The failure-rate window is computed from the recipient rows, not a running counter, so a pause
and resume does not reset the safety net.

---

## 9. Controls (FR-CAM-8) — `wa-campaign-control`

`httpRouteTriggerSettings: { path: '/whatsapp/campaign', httpMethod: 'POST', isAuthRequired: true }`

| Action | Effect |
|---|---|
| `build` | `draft → snapshotting`, enqueues `wa-campaign-snapshot` |
| `preview` | renders 5 sample recipients (no writes) |
| `preflight` | returns the §5 payload (no writes) |
| `testSend` | sends the resolved template to `testRecipientPhones` on the interactive lane, bypassing the audience (FR-CAM-12) |
| `launch` | `ready → scheduled` (or straight to `running` if "send now"); requires the quality gate to pass |
| `pause` | `running|tier_waiting → paused`; already-queued messages still send — the queue cannot be recalled, and the UI says so |
| `resume` | `paused → running` after re-running all guardrails |
| `cancel` | any non-terminal → `cancelled`; all `pending` recipients → `skipped` with `errorCode='CANCELLED'`; already-sent messages keep tracking (FR-CAM-8) |
| `delete` | soft-deletes a campaign **that never launched** (`draft`, `snapshotting` or `ready`, with no `sentCount`, `queuedCount` or `startedAt`) and its snapshot rows; refuses everything else with 409 |
| `archive` / `unarchive` | sets or clears `archivedAt` on a campaign that has **stopped** (`completed`, `cancelled`, `failed`); hides it from the campaigns page and nothing else. Refuses a campaign that is still going with 409; idempotent, answering `changed: false` |

Every action: admin-only (SEC-12), audit-logged with the actor, the previous state and the
audience-definition snapshot, and idempotent (repeating `pause` on a paused campaign is a no-op,
not an error).

**A campaign that ever ran cannot be deleted, by anyone, anywhere.** Its counters, exclusion
breakdown and recipient rows are what the launch audit line points at, so a cancelled or completed
campaign is evidence of a bulk send to real people — and evidence that whoever is embarrassed by it
can delete is not evidence. The rule lives in `canDeleteCampaign` (`domain/campaign/transitions.ts`)
and is enforced twice: this route checks it, and the *WhatsApp Admin* role withholds
`canSoftDeleteObjectRecords` on `whatsappCampaign` and `whatsappCampaignRecipient` so the platform's
own record delete — one gesture with no notion of state — cannot bypass it (10 §roles). Stopping a
campaign is `cancel`; there is no follow-up that makes it never have happened.

### 9.1 The archive

A record that must be kept still has to be got out of the way, which is the whole of what archiving
is: `archivedAt` set, nothing else touched. No status moves, no counter changes, no recipient row is
written, and no worker reads the field — an archived campaign keeps receiving delivery statuses and
its replies keep landing in the inbox exactly as before. The rule is `canArchiveCampaign`
(`domain/campaign/transitions.ts`): only a campaign that has **stopped**.

Three consequences worth stating, because each is a bug in the version that does not have them:

- **The list and the archive are two server-side pages, not one page filtered in the browser.** The
  campaigns feed asks for the newest 50; filtering client-side would mean a workspace that archived
  50 campaigns receives 50 hidden rows and renders "Ainda não há campanhas." — the archive hiding the
  live campaigns instead of the past ones. `GET /s/whatsapp/feed?scope=campaign&archived=1` is the
  other side of the same line, and `listCampaigns` orders the archive by `archivedAt` because "what
  did I put away recently" is the only question anyone asks of one.
- **A campaign that moves again is unarchived automatically.** `transitionCampaign` clears
  `archivedAt` on any real transition, which in practice means `failed → paused`: an admin who
  archived a failed campaign, fixed the template and recovered it must not be left with a campaign
  they can resume and cannot see. A no-op transition leaves the archive alone, or repeating `pause`
  would undo an archive.
- **Nothing is both archivable and deletable.** What may be archived is what finished; what may be
  deleted is what never started. A test asserts the two sets do not intersect for any status.

Archiving is deliberately **not** behind a confirmation modal, unlike cancel and delete: it hides
nothing that cannot be shown again in one click, and a dialog in front of a tidy-up is what makes an
operator leave forty finished campaigns on the page instead of filing them.

---

## 10. Per-recipient tracking and stats (FR-CAM-9, FR-CAM-10)

Recipient status mirrors the message status, driven by the same webhooks as 1:1 traffic
(03 §5 step 8) — there is no separate campaign delivery pipeline, which is the point of AR-19.

`pending → claimed → queued → sent → delivered → read`, with `failed`, `skipped` and `responded`
as side states. `responded` is set by the inbound processor when a reply arrives on a thread whose
`originCampaignId` matches (FR-CAM-13).

Aggregates are maintained by `wa-stats-rollup` (cron, every 30 s) folding `kv` deltas into the
campaign record, giving the ≤30 s p95 freshness target of TRD §3.2 at one write per campaign per
tick rather than one per message (03 §5.2). Derived rates (delivery %, read %, response %) are
computed in the UI, not stored.

`actualCostUsd` accumulates only on `delivered` — matching Meta's billing — so it will always
land slightly under the estimate, and the UI labels both.

---

## 11. Replies (FR-CAM-13)

A campaign message creates or reuses the contact's normal thread (`upsertThread`), so a reply
lands in the ordinary inbox with the 24 h window open and free-form replies enabled. The thread
carries `originCampaignId`, which drives:

- a "From campaign: Setembro 2026" chip on the thread and in the inbox;
- an inbox filter "campaign replies", so reps can work warm responses first;
- the `responded` recipient status and `respondedCount`.

`originCampaignId` is a plain id, not a relation, so deleting a campaign never cascades into
conversation history.

---

## 12. Deferred items (FR-CAM-14, MAY)

CSV export of recipient results, campaign duplication ("send again to non-responders"), A/B
template variants and recurring campaigns. Of these, **duplication filtered to non-responders**
is the highest value and the cheapest — it is a new campaign whose audience definition is
`{ kind: 'manual', personIds: <recipients of X where status != 'responded'> }`, i.e. no new
machinery. Recommended as the first post-release increment.

---

## 13. Requirement trace

| Requirement | Where |
|---|---|
| FR-CAM-1 builder, template restriction, schedule | §2 |
| FR-CAM-2 view / list / manual audience, snapshot immutability | §3, §4 |
| FR-CAM-3 exclusions with reasons | §3.1 |
| FR-CAM-4 variable mapping + fallbacks + 5-recipient preview | §2 step 4, §4 |
| FR-CAM-5 opted-in only for marketing, no override | §3.1 rule 2 |
| FR-CAM-6 pre-flight, RED blocks / YELLOW warns | §5 |
| FR-CAM-7 chunked, resumable, deprioritised, tier-aware | §6, §7, 04 §4 |
| FR-CAM-8 pause / resume / cancel, audited | §9 |
| FR-CAM-9 per-recipient statuses incl. skipped | §10 |
| FR-CAM-10 aggregates and cost | §10 |
| FR-CAM-11 guardrails + pacing surfaced as normal | §8 |
| FR-CAM-12 test send | §9 |
| FR-CAM-13 replies routed to the inbox, marked responded | §11 |
| FR-CAM-14 export / duplication / A-B / recurring | §12 |
| AR-19 same pipeline, deprioritised | §6h → 04 §4 lanes |
| AR-20 chunked, resumable, never twice | §6, §6.1 |
| AR-21 tier ledger with reserve, auto-resume | §7 |
| AR-22 circuit breaker + quality auto-pause | §8 |
| SEC-12 admin-only, launch audit | §2, §9 |
| NFR-S4 100 k audience | §3 |
| NFR-S5 no 1:1 degradation | 04 §4 dual lanes |

---

## 14. As built

Phase 8 landed on 2026-08-16. Where the implementation departs from the design above, this is
what it does instead and why.

### 14.1 Duplicate detection reads the rows, not a `kv` set

§3 specified `seenPhones` as a `kv` set under `wa:campaign-seen:{campaignId}`. It is instead a
query against the recipient rows this campaign has already accepted.

The set was the wrong shape for the job. It has to hold every accepted number for the life of the
snapshot — a megabyte at 100 000 recipients, re-read and re-written on every page, with no
compare-and-swap to make the read-modify-write safe. The rows already exist and already carry
`resolvedPhone`, so asking them is exact, needs no cleanup, and survives a resume that a lost
`kv` write would not.

One subtlety the row query has to get right: only **accepted** rows occupy a number. An excluded
row keeps its `resolvedPhone` for the audit trail, and counting it would report the next person
on that number as a `duplicate` of someone we never messaged — hiding the real reason behind a
misleading one. The filter is therefore `exclusionReason IS NULL`.

### 14.2 Aggregates are recomputed, and the `kv` delta became a hint

§10 specified `wa-stats-rollup` as folding `kv` deltas into the campaign record. It recomputes
from the recipient rows instead, and the delta survives in a smaller role: the *signal* that a
campaign changed at all.

The deltas' purpose was to avoid one Core API write per message, and they do — but so does a
recomputation, which is still one write per campaign per tick. What the deltas cannot do is be
correct: an increment lost to concurrency is a number that stays wrong for the life of the
campaign, and these numbers are what an operator reads to decide whether a send is going well. As
a hint they cost one `kv` read for an idle campaign and are harmless when lost — the next status
webhook writes another.

The counters are **cumulative funnel positions**, not current states. A recipient sits in exactly
one status, so counting `status = SENT` alone would make `sentCount` fall as messages were
delivered: a chart that goes backwards while everything works. `RESPONDED` counts toward sent and
delivered — a reply proves both — but not toward `read`, since a contact with read receipts
disabled can answer a message that never produced a `read` status.

Three writers must note a change, and missing one is invisible: the status processor (delivery
statuses), the inbound processor (a reply, FR-CAM-13), and **the sender's failure path**. The
last was missed and found live: a campaign whose whole batch was denied by policy reported
`failedCount: 0` indefinitely, which is exactly the number an operator would read as "nothing
went wrong".

### 14.3 The rollup runs every minute, not every 30 seconds

§10 asks for 30-second freshness. `cronTriggerSettings` takes a five-field cron pattern, whose
finest granularity is one minute. Rather than guess at six-field support — a wrong pattern
silently never fires, which is the failure mode this project keeps finding — the rollup runs at
`* * * * *` and the freshness target is **≤ 60 s**, not ≤ 30 s. Tightening it is a one-line
change once six-field patterns are confirmed on the target version.

### 14.4 Rebuilding an audience updates rows rather than replacing them

§3 did not say what a rebuild does to the rows a previous build wrote. It upserts: a collision on
the unique `(campaign, person)` index updates the existing row in place.

Skipping would have been simpler and wrong, for the case §3.1 itself describes — a campaign
excludes 412 people for `no_consent`, a consent campaign wins some of them over, and the admin
rebuilds. Skipping leaves them with their stale exclusion and the rebuild changes nothing,
quietly. Updating also makes the resume path idempotent without depending on how Twenty treats a
soft-deleted row's unique index (probe P-4, still unanswered).

### 14.5 The claim is one mutation

§6.1 guarantee 1 is implemented as a select followed by an update **whose own filter still
requires `PENDING`**, using the rows that mutation returned. A tick that lost the race is handed
an empty array rather than a duplicate send. Selecting and then trusting the selection would have
made the guarantee depend on there being only one runner.

### 14.6 Saved-view audiences translate exactly or refuse

See [D-23](00-architecture-decisions.md#d-23--an-audience-filter-is-translated-exactly-or-refused-by-name).
`IS_RELATIVE`, `VECTOR_SEARCH` and `NOT` groups are refused by name at build time.

### 14.7 A campaign thread carries its person

See [D-22](00-architecture-decisions.md#d-22--a-campaign-thread-carries-the-person-the-campaign-chose).
This was a live-found defect in the interaction between the runner and the sender's policy
re-check, not a design change.

### 14.8 Live verification, 2026-08-16

Against a live Twenty v2.31.0 and the connected WABA. **No message was sent to Meta**: every run
was arranged so the sender's policy gate denied before the provider call, and the workspace
finished with zero outbound messages of any kind.

| What | Result |
|---|---|
| Exclusion matrix over a manual audience of 8 | all six reasons fired exactly once; `recipientCount: 2`, `excludedCount: 6` |
| Parameters frozen at snapshot | `body: ["Ana", "a festa da Pixel Infinito"]`, button `abc123` on the row |
| Pre-flight | cost $0.045 at $0.0225/message, tier 250 with a 25 reserve and 225 available, spread 2/1 day, GREEN gate open, per-reason samples of 10 |
| Create with an unpublished template | 400 — FR-TPL-2 holds at the campaign boundary too |
| Launch before building | 409 "no recipients — build the audience first" |
| Runner tick | fired at `06:12:00.134Z`, claimed 2, created threads and messages on the campaign lane, one `scheduleSend` for the batch |
| Send-time policy re-check | both denied, **no Meta call, no WAMID** — an opt-out that arrived after the snapshot took effect |
| Completion | `COMPLETED` on the following tick at `06:13:00.162Z`, `completedAt` set |
| Saved-view audience | a real view (`name CONTAINS "PROBE8"` AND `optInStatus IS [OPTED_IN]`) selected exactly the 5 opted-in probes out of 8 — the `AND` translated |
| Untranslatable filter | adding `createdAt IS_RELATIVE PAST_30_DAY` made `build` answer 400 naming that filter |
| Cancel | `CANCELLED`, pending recipient → `SKIPPED` with `errorCode: CANCELLED`; already-sent messages keep tracking |
| Cancel again | 200 with `abandoned: 0` — idempotent, not an error (FR-CAM-8) |
| Resume a cancelled / pause a completed campaign | 409 "is terminal: a campaign cannot leave it" |
| Edit a cancelled campaign | 409 |
| Unknown campaign / missing id / unknown action | 404 / 400 / 400 |

Not proven live, and honestly so: **a real Meta send**, and therefore the tier ledger's
increment, `pacingObserved`, the failure-rate breaker and the delivered/read funnel. All are unit
tested; none has met Meta. They need one campaign to a number the business is willing to message.
