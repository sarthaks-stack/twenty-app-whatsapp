# 09 — Workflows, timeline and notifications

Implements FR-WF-1 … FR-WF-3, FR-TL-1 … FR-TL-3, FR-IN-5 (as re-specified by D-10).

---

## 1. Workflow action: "Send WhatsApp template" — FR-WF-1 (MUST)

Specified in [04 §3](04-outbound-pipeline.md#3-wa-send-template-action--workflow-action). Summary
of the contract as it appears in the workflow builder:

```ts
workflowActionTriggerSettings: {
  label: 'Send WhatsApp template',
  icon: 'IconBrandWhatsapp',
  inputSchema: [
    { type: 'record', objectUniversalIdentifier: PERSON, label: 'Person' },
    { type: 'string', label: 'WhatsApp account', enum: [/* resolved at design time */] },
    { type: 'string', label: 'Template' },
    { type: 'object', label: 'Variables' },
    { type: 'boolean', label: 'Create conversation if missing' },
  ],
  outputSchema: [
    { type: 'string', label: 'messageId' },
    { type: 'string', label: 'threadId' },
    { type: 'string', label: 'status' },        // accepted | denied | failed
    { type: 'string', label: 'denialReason' },  // opted_out | template_unavailable | …
  ],
}
```

**A policy denial is a result, not an exception.** The step completes with
`status: 'denied'` so a workflow can branch (`if denied → create a Task "contact by phone"`)
instead of the run dying. Only infrastructure failures throw.

The action runs the same `evaluate()` gate and the same interactive lane as a rep's send, which
is what makes FR-CON-4 true by construction rather than by discipline.

**As built (2026-08-17)** — `wa-send-template-action`. Three corrections to the sketch above, each
found by building it:

- **`inputSchema` is positional over the handler's parameters**, not a list of named fields. Left
  undefined, the CLI derives it by parsing the handler's signature and keeps only the first
  parameter, requiring it to be an object type literal. Five array entries would declare a
  five-argument handler and bind none of them to the single object the handler receives — so it is
  **one** `object` entry whose `properties` are the five inputs.
- **`Person` arrives as a record *or* an id**, depending on how the step was wired: a workflow
  variable bound to `{{trigger.record}}` resolves to an object, a hand-typed value to a string.
  Reading both is six lines; reading one is a step that fails for most of the ways an author can
  build it, with `PERSON_UNKNOWN` as the only clue. The same applies to booleans, which arrive as
  `"false"` — truthy — when bound to a variable.
- **Variables are bound by key against the template's spec** (`domain/workflow-parameters.ts`).
  This is the one place in the app where a caller supplies variables having never seen the
  template, so `{ "1": "Ana" }`, `{ "nome": "Ana" }` and an already-resolved `body` array all bind
  to the spec's own ordering — and anything unresolvable comes back **empty**, because empty is a
  named missing variable that refuses the send, while a stringified `null` is a message a customer
  reads.

### Making the step configurable (revised 2026-08-17)

The first build shipped `WhatsApp account` and `Template` as `string` inputs, following this spec's
own "select, resolved at design time". Nothing *can* be resolved at design time — the numbers and
templates live in the workspace, not in the manifest — so what an author actually got was two text
boxes and an instruction to paste a WABA id. That was the app's mistake, not the platform's
limitation:

- **`whatsappAccount` and `whatsappTemplate` are ordinary Twenty objects**, so declaring both
  inputs as `type: 'record'` with their `objectUniversalIdentifier` gives the builder the same
  picker `Person` gets, listing the real rows by their `name`. Neither needs an enum.
- **The picker lists every template**, including unapproved and unpublished ones — there is no
  filter on a record input. The gate still refuses those with `TEMPLATE_UNAVAILABLE`, and the input
  label says which are usable. A visible refusal beats an invisible filter here: an author whose
  template is missing from a filtered list has nothing to read.
- **Variables are five labelled fields, not a JSON box.** Twenty cannot load a template's variables
  on demand — the schema is in the manifest and there is no resolver it calls to recompute one from
  a half-filled step — so "field by field" has to mean a *fixed* set of fields.
  `bodyVariable1…bodyVariable5` covers essentially every template Meta approves, and each is a
  plain `string`, which is also the only type Twenty gives an `(x)` binding to: an `object` input
  renders as a bare box with none, which had made the field that most needs
  `{{trigger.record.name.firstName}}` the only one unable to take it. Five empty boxes on a
  template with no variables is the cost, and it is the right way round — an author who cannot find
  where to type is stuck, one looking at a box they do not need just leaves it.
- **`advancedParameters` is the escape hatch** for a header image, a button URL, a named variable or
  a sixth: a multiline JSON string merged *over* the numbered fields, so it overrides rather than
  competes. Malformed JSON resolves every variable to empty, which refuses the send with each one
  named rather than sending a message with gaps in it.
- **A number binds a named template by position.** The numbered fields can only send positions, so
  without a positional fallback in `bodyValueFor` they bound nothing at all on a `{{nome}}`
  template — a silent failure of the whole feature for that family of templates. Caught by a test,
  not by the UI, because it fails safe: an unbound variable refuses the send.
- **The property names set the field order**, which is why they look padded. Step inputs are stored
  as Postgres `jsonb`, which orders keys by length then bytewise, and the builder renders them in
  stored order — so 8 · 9 · 10 · 13 · 18 · 21 characters reads top to bottom in the order an author
  fills it in. Observed, not assumed: the first build declared `parameters` before `templateId` and
  the panel showed Variables above Template.
- **`parameters` is still read** so a step configured before the fields existed keeps working.
- **All three record inputs go through the same `idOf`.** A picked record arrives as an object, so
  reading `templateId` as a string would look up a template *named* `[object Object]`.

`Template` still accepts a bare name as a fallback, for a value bound from a workflow variable
rather than picked. Two templates sharing a name in different languages are two different messages,
so that is refused rather than guessed at.

**The step icon is the application logo, not `workflowActionTriggerSettings.icon`.**
Twenty renders the app's logo in the step header, so `IconBrandWhatsapp` had no effect and what an
author saw above "Send WhatsApp template" was `create-twenty-app`'s four-grey-squares placeholder.
The icon name is kept because it is correct and costs nothing if a later version does read it.

Replacing the file was not enough on its own: public assets are served from a path-derived URL with
`Cache-Control: public, max-age=3600` and no content hash, so every browser that had already loaded
`public/logo.svg` kept showing the old icon for up to an hour *while the server served the new one*
— an unfalsifiable bug report. The asset is therefore named `public/logo-whatsapp.svg`: a new
filename is a new URL. **Rename it whenever the logo changes.**

**Nothing needs to be done about "Expected Output Body".** It looks like an unfilled required field
and is not: the step's `settings.outputSchema` is already populated from the declared `outputSchema`
— `status`, `messageId`, `threadId`, `denialReason`, `missingVariables`, `warnings`, each with its
type and label — so downstream steps can reference them today. The box is an optional override whose
only added value is *sample* values for the builder's preview, and `InputSchemaProperty` has no
field for an example, so the app cannot supply them. Verified by reading the stored step JSON on a
live server rather than inferred.

---

## 2. Database-event triggers — FR-WF-2 (SHOULD)

The app's objects are ordinary Twenty objects, so their lifecycle events are available to
workflows without any code from us. What we owe the operator is that the events are *useful*:

| Event | Fires when | Typical automation |
|---|---|---|
| `whatsappMessage.created` (filter `direction = inbound`) | any inbound message | create a Task "responder ao lead", post to Slack, notify the assignee |
| `whatsappThread.created` | a brand-new conversation | assign, tag, add to a list |
| `whatsappThread.updated` (`updatedFields: ['status']`) | thread reopened/closed | SLA tracking |
| `whatsappCampaignRecipient.updated` (`updatedFields: ['status']`) | recipient responded/failed | route warm responses |
| `whatsappConsentEvent.created` | opt-in/opt-out recorded | sync consent to another system |

Design consequence: the inbound processor writes the message record **with all its fields
populated in the create call**, not create-then-patch. A create followed by three patches would
fire one create event and three update events, making `whatsappMessage.created` an unreliable
trigger for automations that read `body` or `type`.

The one exception is `mediaFile`, which the media worker necessarily patches later. Workflows
that need media must trigger on `whatsappMessage.updated` with
`updatedFields: ['mediaFile']` — documented in the operator runbook.

---

## 3. "Send free-form WhatsApp message" action — FR-WF-3 (MAY)

Identical plumbing to §1 with `kind: 'freeform'`. The policy gate denies it when the window is
closed at execution time, with `denialReason: 'window_closed'` — an explicit, logged, branchable
outcome, as the requirement asks. Included if capacity allows; it is ~40 lines given §1.

---

## 4. Timeline activities — FR-TL-1 (MUST)

Written directly to the standard `timelineActivity` object (D-9). One helper,
`src/server/timeline.ts`, is the only writer:

```ts
createTimelineActivity({
  name,                      // see the catalog below
  happensAt,                 // the domain event time, not the write time
  properties,                // small, stable JSON — see below
  targetPersonId,            // the Person the activity belongs to
  linkedRecordId,            // the whatsappMessage / whatsappThread / whatsappCampaign id
  linkedObjectMetadataId,    // that object's metadata id, resolved once and cached in kv
  linkedRecordCachedName,    // human label, e.g. the template name or a message excerpt
});
```

### 4.1 Event catalog

| `name` | Emitted by | `properties` |
|---|---|---|
| `whatsapp.message.received` | inbound processor | `{ type, preview, threadId, hasMedia }` |
| `whatsapp.message.sent` | outbound sender on `accepted` | `{ type, preview, threadId, sentByMemberId, sourceKind }` |
| `whatsapp.template.sent` | outbound sender, template sends | `{ templateName, language, category, campaignId? }` |
| `whatsapp.message.failed` | outbound sender / status processor | `{ errorCode, threadId }` |
| `whatsapp.consent.opted_in` / `.opted_out` | `setConsent` | `{ method, actorId, wordingShown }` |
| `whatsapp.thread.assigned` | thread actions | `{ from, to, actorId }` |
| `whatsapp.thread.relinked` | thread actions | `{ fromPersonId, toPersonId, actorId }` |
| `whatsapp.campaign.sent` | campaign runner | `{ campaignId, campaignName, templateName }` |

`preview` is truncated to 120 characters. Message **content is duplicated** into the timeline
properties deliberately — the timeline must stay readable after a retention purge removes message
bodies (SEC-9), and a 120-character excerpt is the agreed granularity. Q-4 (retention policy) may
change this; if counsel requires full purge, `preview` becomes `null` and the timeline shows only
"Mensagem recebida".

### 4.2 Volume control

At 50 000 messages/day, one timeline activity per message is 50 000 rows/day on a table Twenty
uses for its own purposes. Mitigations, all configurable:

- `WA_TIMELINE_MODE` (application variable): `all` · `summary` · `off`, default **`summary`**.
- In `summary` mode a timeline activity is written for: the **first** message of a thread, the
  first inbound of a day per thread, every template send, every failure, and every consent or
  assignment change — not for each message in an active back-and-forth. The full transcript lives
  in the WhatsApp tab, which is where a rep actually reads it.
- `all` is available for low-volume installs that want literal parity with the TRD's wording.

This is a deliberate deviation from a literal reading of FR-TL-1 ("inbound message … SHALL appear
as timeline activities") in favour of a usable timeline. The requirement's intent — *a person's
record shows their WhatsApp history* — is met by FR-UI-1 in every mode.

### 4.3 Company roll-up

`timelineActivity` exposes `targetCompany`. Activities are written with both `targetPerson` and,
when the person has a company, `targetCompany` — giving FR-TL-1's "(and its Company)" for free.

---

## 5. Reporting — FR-TL-2 (SHOULD), FR-TL-3 (MAY)

**FR-TL-2** is satisfied structurally: `whatsappMessage`, `whatsappThread`, `whatsappCampaign` and
`whatsappCampaignRecipient` are ordinary objects, so Twenty's views, filters, group-bys and
aggregations work on them with no code. The app ships one "All messages" view (02 §11); everything
else is user-built.

**FR-TL-3** (dashboard widget, MAY) is a `definePageLayout` of type `DASHBOARD` with chart widgets
over those objects:

| Widget | Configuration |
|---|---|
| Messages per day | line chart over `whatsappMessage.waTimestamp`, grouped by `direction` |
| Delivery funnel | bar chart over `whatsappMessage.status` |
| Failure rate | aggregate chart, `failed / total` |
| Estimated spend | aggregate `SUM(billableCostUsd)` grouped by `templateCategory` |
| Median response time | requires a derived field; **deferred** — computing it needs a
  `firstResponseSeconds` on the thread, written by the outbound sender when it answers an
  unanswered inbound. One field and three lines; included only if the MAY is picked up. |

Because `billableCostUsd` is written on delivery (02 §3), the spend widget is real money, not an
estimate — the one number stakeholders will check first.

---

## 6. Notifications — FR-IN-5, as re-specified by D-10

There is no notification object or push API available to apps. Three layers, all delivered:

**Layer 1 — unread state (always on).**
`whatsappThread.unreadCount` is incremented by the inbound processor and zeroed by the
`markRead` action. The Inbox shows per-thread badges and a filtered count; the Person tab shows
the thread's badge. This is the durable, offline-safe signal.

**Layer 2 — live toast.**
A headless front component (`isHeadless: true`) mounted by the Inbox page polls the feed and
calls `enqueueSnackbar` for each new inbound message assigned to the current user, deduped by
message id. Fires only while that page is open — an honest limitation, stated in the runbook.

**Layer 3 — escalation via workflow (operator-configured).**
`whatsappMessage.created` (§2) routed to a Task, an email, or the first-party Slack app. This is
the only layer that reaches an offline rep, and it is configuration rather than code, which is
also why it belongs to the operator's judgement rather than ours.

The settings UI ships a one-click "Create the default notification workflow" button that
provisions a Workflow creating a Task for the thread assignee on inbound messages — turning
layer 3 from a documentation footnote into a real default.

**As built (2026-08-17)** — `POST /s/whatsapp/account { action: 'createNotificationWorkflow' }`,
admin-only, idempotent by workflow name.

It creates the workflow, a `DRAFT` version, the `whatsappMessage.created` trigger and a
`CREATE_RECORD` Task step — and **stops there**, returning three machine-coded review notes the
settings panel renders. Two reasons, and both are the honest ones rather than caution:

- **Activation is not in the app-facing API.** There is no `activateWorkflowVersion` mutation on
  the object graph, and writing `status: 'ACTIVE'` without the automated-trigger row the platform
  normally creates would produce a workflow that says it is active and never fires.
- **The direction filter is deliberately not written.** `whatsappMessage.created` fires for *both*
  directions, so without a `direction = INBOUND` filter every message a rep sends creates a Task
  telling them to reply to themselves. The filter's JSON shape belongs to Twenty's workflow engine,
  and one this app guessed at and got wrong would look present and match nothing — the same
  failure with none of the visibility. So it is `FILTER_INBOUND`, the first review note, on the way
  to the builder the operator has to open anyway.

Which leaves the button doing the part that is genuinely hard to discover — the trigger is called
`whatsappMessage.created`, a name that appears nowhere in the builder — and leaving the two
decisions that are the team's to whoever owns their inbox.

---

## 7. Requirement trace

| Requirement | Where |
|---|---|
| FR-WF-1 template workflow action | §1, 04 §3 |
| FR-WF-2 inbound database-event triggers | §2 |
| FR-WF-3 free-form action | §3 (MAY) |
| FR-TL-1 timeline on Person and Company | §4 |
| FR-TL-2 standard views over messages | §5 |
| FR-TL-3 dashboard widget | §5 (MAY) |
| FR-IN-5 notification to assignee | §6 (re-specified — D-10) |
| FR-CON-4 workflows respect consent | §1, 06 §12 |
