# 14 — Open questions

Q-1 … Q-7 carry over from TRD §16. Q-8 … Q-16 were raised by this specification work.
Each has an owner and a "needed by" that is a real gate, not a wish.

---

## Carried from the TRD

| # | Question | Owner | Needed by | Why it blocks |
|---|---|---|---|---|
| **Q-1** | Confirm current Rest-of-Africa rates from Meta's **official** rate card. The TRD's figures ($0.0225 / $0.0040) are third-party mirrored. | Product | Before campaign cost estimates go live (release gate) | The pre-flight panel shows a currency figure an admin will act on. Wrong rates are worse than no rates. Mitigation already built: rates are application variables (01 §4.2), so correcting them is a settings edit. |
| **Q-2** | Business verification status of the company's Meta Business portfolio. | Ops | Project kickoff | Determines whether go-live campaigns run at 250/day or 1 000+/day (R-10). Does **not** block the release. |
| **Q-3** | Should threads auto-close after N days of silence, and what N? | Sales lead | During build (week 8) | `WA_AUTO_CLOSE_DAYS` exists with default `0` (disabled), so a late answer costs nothing (05 §3.2). |
| **Q-4** | Message-content retention policy — unlimited vs N months — with legal input incl. Lei 22/11. | Legal | **Before go-live** | Changes default settings and possibly the timeline `preview` behaviour (09 §4.1). Also gates the opt-in and privacy wording (06 §10). |
| **Q-5** | Exact logic-function timeout and dependency-size ceilings on the target Twenty version. | Eng | Week 1 (probes) | Chunk sizes across the snapshot, runner and media worker assume ~120 s is available. If the real ceiling is much lower, batch sizes drop and the self-requeue interval shortens — a config change, but one that must be measured, not guessed. |
| **Q-6** | Does the sales team need WhatsApp on **Opportunity** records, not just Person? | Sales lead | During build (week 6) | A page-layout tab on `opportunityRecordPage` reading the point-of-contact's thread is ~1 day *if* asked before E5 ships; a retrofit is more. The data model needs no change. |
| **Q-7** | Expected typical campaign audience size and monthly campaign volume. | Sales/Marketing lead | Kickoff | Drives tier planning, verification urgency and the cost model. Also decides whether the NFR-S4 100 k-recipient load test is a real scenario or a ceiling test. |

---

## Raised by this specification

| # | Question | Owner | Needed by | Detail |
|---|---|---|---|---|
| **Q-8** | Does the server-route endpoint accept `GET`, and is a `Response` body returned verbatim? | Eng | Week 1 | Probe P-1. Decides whether the Meta callback needs a reverse-proxy alias (D-1). The proxy path is specified and the verify route is built either way, so this is a simplification question, not a blocker. |
| **Q-9** | What request-rate limit actually applies to app HTTP routes (`/s/*`) for a workspace token? | Eng | Week 1 | Probe P-2. Sets the polling intervals for 25 concurrent reps (D-6). If the limit is tight, focused polling moves from 3 s to 10 s — a felt UX difference that the sales team should be told about, not discover. |
| **Q-10** | Can an app role write `timelineActivity` records? | Eng | Week 1 | Probe P-3. Decides whether FR-TL-1 is delivered as specified or downgraded (D-9). |
| **Q-11** | Does a soft-deleted record still occupy a unique index? | Eng | Week 1 | Probe P-4. Decides whether the retention purge soft-deletes or hard-destroys (D-12, 10 §4.2). |
| **Q-12** | Which **timeline volume mode** does the business want: an entry per message, a daily summary, or off? | Sales lead | Week 8 | `WA_TIMELINE_MODE` defaults to `summary` (09 §4.2). This is a deliberate deviation from a literal reading of FR-TL-1 and should be an informed choice, not a default nobody saw. |
| **Q-13** | Who receives operational alerts, and through which channel? | Ops | Before go-live | There is no notification API (D-10). Options: the settings health panel only, a timeline activity on an admin, an outbound WhatsApp message to on-call numbers via an operator-published utility template, or a Slack workflow. The last two need a decision **and** setup. |
| **Q-14** | Confirm the exact opt-out and opt-in keyword lists and the confirmation wording, in pt-PT. | Sales lead + Legal | Week 8 | Defaults are `STOP/SAIR/PARAR/CANCELAR` and `START/INICIAR/SIM` (06 §10). The confirmation wording is stored as consent evidence, so counsel should see it. |
| **Q-15** | Should thread visibility default to workspace-wide or restricted-to-assignee? | Sales lead | Week 6 | Spec default is workspace-wide (SEC-7). Restricted mode depends on probe P-7 for API-level enforcement; without it, the control is route-level only, which should be an accepted limitation rather than a surprise. |
| **Q-16** | Is a Meta **test WABA + phone number** available in week 1? | Ops | Week 1 | Without it, the webhook fixtures (12 §4) must be hand-written, and hand-written fixtures are precisely the ones that are subtly wrong. This is the single highest-leverage logistics item in the plan. |

---

## Decisions taken without asking

Recorded here so they can be challenged rather than discovered:

| Decision | Rationale | Cost of reversing |
|---|---|---|
| Timeline defaults to `summary`, not one entry per message | 50 000 rows/day on a shared table would make the Person timeline unusable | Config change (Q-12) |
| Inbound-created People are `unknown`, never `opted_in` | Messaging support is not marketing consent; treating it as consent is the fastest route to a RED rating | None — this should not be reversed |
| Utility campaigns exclude only `opted_out`; marketing campaigns require `opted_in` | Utility templates are transactional | Pure-function change + test |
| Inbound auto-download ceiling of 25 MB | Buffering 100 MB in a logic function is a memory/timeout hazard at unmeasured limits | Config change (`WA_MEDIA_AUTO_DOWNLOAD_MAX_BYTES`) |
| `terminal_unknown` on an ambiguous send outcome, rather than retrying | Never double-message a customer; accept a rare false "failed" | Small, but the trade-off should be explicit |
| Campaign objects stay app-owned despite the new `messageCampaign` standard object | The standard object is email-shaped and young (D-13) | Significant — revisit only at the R-1 convergence point |
| Agent group on an account is an `ARRAY` of member ids, not a relation | Avoids a join object with no other purpose (05 §3.3) | Moderate; would become a real relation if the group grows features |
