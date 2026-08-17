# 08 — Front components (UI surfaces)

Implements FR-UI-1 … FR-UI-7, FR-ACC-1 … FR-ACC-5, and the UI halves of FR-OUT, FR-TPL, FR-CAM.
Depends on D-6 (polling budget) and D-7 (scroll constraints).

> **Sandbox reality check.** These components run in a Web Worker at an opaque origin, rendering
> through Remote DOM. `IntersectionObserver`/`ResizeObserver` throw. `createPortal` renders
> nothing. `.focus()`, `.click()`, `.scrollIntoView()` throw. `scrollTop` assignment is a no-op.
> `document.addEventListener` never fires. `FileReader` does not exist. `matchMedia` throws.
> Canvas draws nothing. Every design below is shaped by that list, not by preference.

---

## 1. Registered components

| Identifier | File | Kind | Surfaced by |
|---|---|---|---|
| `FC_PERSON_THREAD` | `wa-person-thread.tsx` | widget | `definePageLayoutTab` on `STANDARD_PAGE_LAYOUT.personRecordPage` (FR-UI-1) |
| `FC_SIDE_PANEL_CHAT` | `wa-side-panel-chat.tsx` | side panel | `defineCommandMenuItem`, `availabilityType: 'RECORD_SELECTION'`, `availabilityObjectUniversalIdentifier: person` (FR-UI-3) |
| `FC_INBOX` | `wa-inbox.tsx` | standalone page | `definePageLayout` (STANDALONE_PAGE) + nav item (FR-UI-2) |
| `FC_CAMPAIGNS` | `wa-campaigns.tsx` | standalone page | `definePageLayout` + nav item (FR-CAM-1) |
| `FC_SETTINGS` | `wa-settings.tsx` | settings section | `defineSettingsFrontComponent` (FR-ACC-1…5) |

Shared React lives in `src/components/` and is **not** registered — only these five are.

`frontComponentSharedDependencies` in `package.json` declares `react`, `react-dom/client`,
`twenty-ui/input`, `twenty-ui/data-display`, `twenty-ui/icon`, `twenty-ui/theme-constants` so the
five surfaces share one cached bundle.

---

## 2. The feed route — the single data path (D-6)

`GET /s/whatsapp/feed` (`LF_INBOX_FEED_ROUTE`, `isAuthRequired: true`, `timeoutSeconds: 20`).

| Query | Values |
|---|---|
| `scope` | `thread` · `inbox` · `campaign` · `bootstrap` |
| `id` | thread id, person id (with `by=person`), or campaign id; **omitted** on `scope=campaign` means the campaign *list* |
| `by` | thread only: `thread` (default) · `person` |
| `since` | ISO-8601 cursor; omit for a full first page |
| `filter` | inbox only: `mine` · `unassigned` · `all` · `campaign_replies` · `window_expiring` · `closed` |
| `before` | opaque cursor: thread — older messages; inbox — the next page of rows |
| `limit` | 1…200, default 50 |
| `archived` | campaign list only: `0` (default, the live campaigns) · `1` (the archive). A page of its own, not a filter over the live one — see [07 §9.1](07-campaigns.md#91-the-archive) |

Every unrecognised value is **refused with a 400**, never defaulted. A typo in `filter`
falling back to `all` would show a rep every conversation in the workspace under a heading
that said "Minhas" — the same class of failure as D-34.

`closed` is not in the original table. `close` exists so a handled conversation leaves the
list, which means the other five filters exclude closed threads and nothing brings one back;
a state with no way out of it is a bug, so the sixth filter is the way back.

Response envelope, identical for every scope:

```jsonc
{
  "serverTime": "2026-08-15T09:12:03.114Z",     // the clock when the read started
  "nextSince":  "2026-08-15T09:12:03.114Z",     // what to send back as `since`
  "truncated": true,                            // optional: a burst did not fit; poll again now
  "scope": "thread",
  "account": { "id": "...", "qualityRating": "GREEN", "isTestAccount": false, "status": "CONNECTED" },
  "thread":  { /* thread fields incl. serviceWindowExpiresAt, windowState, status, person */ },
  "messages": [ /* delta or page, newest first */ ],
  "olderCursor": "...",                         // thread: pass as `before` for the page above
  "threads":  [ /* inbox rows */ ],
  "nextCursor": "...",                          // inbox: pass as `before` for the next page
  "campaign": { /* campaign + counters */ },
  "campaigns": [ /* the list, newest first */ ],
  "templates": [ /* published + usable; full loads only, never on a delta */ ],
  "permissions": { "canSend": true, "canManageTemplates": false, "canManageCampaigns": false },
  "policy": { "allowed": true, "reason": null, "warnings": ["WINDOW_EXPIRING_SOON"] }
}
```

`serverTime` and `nextSince` are separate because they are not always the same value. The
clock is captured **before** the first query — taking it afterwards would skip every row
written while the queries ran — and `nextSince` normally equals it. When a delta hits its
200-row ceiling, `nextSince` is instead the last row's `updatedAt` and `truncated` is set, so
the client walks the burst through rather than stepping over the part it never received.

Deltas filter on `updatedAt`, not `createdAt`: a message delivered five minutes after it was
sent is not a new row, and a chat that only learned about new rows would show ticks that never
advanced. The comparison is inclusive, so the boundary row repeats on every poll — the client
merges by message id, and a duplicate costs nothing while a gap is permanent.

Messages are ordered by `createdAt`, not `waTimestamp`: an outbound message has no WhatsApp
timestamp until Meta accepts it, so ordering by it would file everything a rep just sent below
messages from last year for as long as the send took.

The inbox has **no delta mode**. A thread's position in the list changes when a *different*
thread receives a message, so an incremental list would hold a stale order until something in
it happened to change. Fifty rows per poll is the honest read.

Two design points that matter:

- **`policy` is computed server-side and returned with the thread.** The composer does not
  re-derive the window rule in the browser; it renders whatever the policy module said (AR-17).
  One rule, one implementation, no drift between the disabled state and the server's answer.
- **`permissions` is returned per request.** The UI hides what the caller cannot do, and every
  mutating route re-checks it server-side anyway (SEC-5).

### 2.1 `useFeed` hook (`src/components/common/use-feed.ts`)

```ts
const { data, error, isStale, refresh } = useFeed({ scope, id, filter, intervalMs });
```

- Holds an `inFlight` ref and **skips** a tick rather than stacking requests (the sandbox drops
  `AbortSignal`, so cancellation is not available).
- Tracks focus with `onFocus`/`onBlur` on the root element — `window.addEventListener('blur')`
  never fires in this sandbox — and switches to the blurred interval.
- Suspends after 15 minutes without interaction and renders a "Reconnect" chip (D-6).
- Exponential backoff on error (2×, capped at 60 s) with a visible offline banner rather than a
  silent stall.
- Merges deltas into a `Map` keyed by message id so an optimistic message is replaced, not
  duplicated, when the server version arrives.

---

## 3. Chat (`src/components/chat/`) — FR-UI-1, FR-OUT-1…5

The same `<ThreadView>` renders in the Person tab, the side panel and the inbox detail pane. Only
the chrome differs.

```
┌─ ThreadHeader ────────────────────────────────────────────────┐
│ avatar · profileName · +244 923 000 000 · [needs-review?]     │
│ assignee picker · status picker · consent chip · ⋯ menu        │
├─ WindowChip ──────────────────────────────────────────────────┤
│ 🟢 Janela aberta — fecha em 5h 12m      |  🔒 Janela fechada   │
├─ MessageList (flex-direction: column-reverse) ────────────────┤
│  … newest at the visual bottom …                              │
│  [Carregar mensagens anteriores]   ← visual top               │
├─ Composer ────────────────────────────────────────────────────┤
│ textarea | 📎 | 😀 | [Enviar]      or      [Escolher modelo]   │
└───────────────────────────────────────────────────────────────┘
```

### 3.1 MessageList — the D-7 mechanics

- Container: `display:flex; flex-direction:column-reverse; overflow-y:auto`.
- The messages array is held **newest-first** and rendered in that order, so the browser's
  column-reverse scroll anchoring pins new messages to the bottom with **no scripted scroll**,
  and preserves position when older messages are appended to the array (rendered above).
- Older pages: a "Carregar mensagens anteriores" button at the array end, plus an `onScroll`
  handler firing the same action when the reverse-scroll offset nears the extent (reading
  `scrollTop` is allowed; writing it is not).
- 50 messages per page (NFR-P4).
- Day separators computed during render by comparing adjacent `waTimestamp` dates in
  `Africa/Luanda`.

### 3.2 MessageBubble

| Element | Rule |
|---|---|
| Alignment | inbound left, outbound right |
| Status ticks | `queued` ⏱ · `accepted`/`sent` ✓ · `delivered` ✓✓ · `read`/`played` ✓✓ blue · `failed` ⚠ (FR-UI-1) |
| Failure | red border + mapped message + **Repetir** action when retryable (FR-OUT-4, FR-UI-6) |
| Quoted reply | the quoted message rendered as an inset strip above the body (FR-OUT-3) |
| Reactions | `payload.reactions` as a chip row on the target bubble; `type='reaction'` rows are not rendered (02 §3) |
| Image / sticker | `<img>` from the stored file URL, `max-width:100%`, lazy via `loading="lazy"` (no observers) |
| Audio | `<audio controls>`; voice notes labelled "Mensagem de voz" |
| Video | `<video controls preload="metadata">` |
| Document | filename + size + download link |
| Deferred media (D-8) | "Transferir (18 MB)" button calling the media worker |
| Template send | template name badge + the resolved body |
| Unsupported | grey italic placeholder + "Ver detalhes" revealing `payload` (FR-IN-1) |
| Campaign send | small "Campanha: …" chip |

### 3.3 Composer — FR-OUT-1, FR-OUT-2

Driven entirely by `policy` from the feed:

| `policy` | Composer |
|---|---|
| `allowed: true` (window open) | free-form enabled, countdown chip, attachment + template buttons |
| `reason: 'window_closed'` | textarea disabled with an explanatory line; the primary button becomes **Escolher modelo** (FR-OUT-2/5) |
| `reason: 'opted_out'` | everything disabled; "Este contacto cancelou a subscrição" (FR-CON-2) |
| `reason: 'account_not_connected'` | disabled with a link to settings |
| warnings | non-blocking banner above the composer |

Mechanics forced by the sandbox:

- Controlled `<textarea>`; **no autofocus** (`.focus()` throws).
- Enter sends, Shift+Enter newlines, via `onKeyDown`.
- Attachments use the host `uploadFile()` (no `FileReader`), get validated against Meta's caps
  client-side, and send a `fileId` (04 §2).
- Emoji picker (FR-UI-7, MAY) must be a plain grid of characters — no portal, no popper library
  that measures with observers.
- On send: optimistic bubble at `queued` with the `clientToken`, replaced when the feed returns
  the server record; on `409` the bubble turns into an inline policy error rather than a toast.

---

## 4. Inbox (`FC_INBOX`) — FR-UI-2

Two-pane on wide viewports, list-then-detail on narrow ones, decided with **container queries**
(`@container`) — `matchMedia` throws and `@media` matches the browser window rather than the
widget (documented sandbox behaviour).

- **Left**: thread rows — avatar, name, preview with direction prefix, relative time, unread
  badge, window countdown chip (FR-UI-6), campaign-reply chip. Filters: `mine` / `unassigned` /
  `all` / `campaign_replies` / `window_expiring`; sorted by `lastMessageAt`.
- **Right**: the same `<ThreadView>`.
- **Top banner**: quality rating warning when `yellow`/`red`, test-account badge, and a
  connection-error banner when `account.status !== 'connected'` (FR-UI-6).
- Pagination: 50 rows plus "Carregar mais". No virtualised list — virtualisation libraries depend
  on measurement APIs that throw here.
- Hosts the headless toast component (D-10 layer 2).

---

## 5. Campaigns page (`FC_CAMPAIGNS`) — FR-CAM-1, FR-CAM-10

- **List**: name, status pill, template, recipients, sent/delivered/read/failed, response rate,
  cost, created by. Live-refreshed every 10 s while any campaign is `running`.
- **Builder**: the four steps of [07 §2](07-campaigns.md#2-builder-fr-cam-1) as a wizard, each
  step persisted to the draft. Progress bar during `snapshotting` reading `recipientCount`.
- **Pre-flight panel**: the five panels of [07 §5](07-campaigns.md#5-pre-flight-fr-cam-6), with
  the launch button gated on quality.
- **Detail**: aggregate counters, a status-breakdown bar, the exclusion breakdown with samples,
  the pacing notice when `pacingObserved`, and a recipient table (paged, filterable by status)
  linking to each Person and thread.
- **Controls**: pause / resume / cancel behind `openCommandConfirmationModal`, visible only when
  `permissions.canManageCampaigns` (SEC-12).
- **Archive**: an `Arquivadas` chip beside the six filters, which asks the server for a different
  page (`archived=1`) rather than narrowing this one, on a 60-second poll because nothing in it is
  moving. The archive names itself in the heading, drops the "New campaign" button, dates its rows by
  `archivedAt` instead of `createdAt`, and is reachable from the empty state as well as the chips —
  archiving the last campaign must not hide the archive along with it. Archive and unarchive sit in
  the detail screen's header with no confirmation modal ([07 §9.1](07-campaigns.md#91-the-archive));
  an archived campaign says so on its own record, because a campaign quietly missing from the list is
  one somebody will report as deleted.
- **Delete**: last on the detail screen, and only while the campaign has never launched
  ([07 §9](07-campaigns.md#9-controls-fr-cam-8--wa-campaign-control)). A campaign that has sent
  something shows *nothing* there — no disabled button and no explanation of a rule that cannot be
  broken, because the honest answer to "how do I delete this" is that the record of a bulk send
  stays. While it is still deletable, the note says that launching ends the option, which is the one
  moment the rule is worth a sentence.

---

## 6. Settings (`FC_SETTINGS`) — FR-ACC-1 … FR-ACC-5, NFR-O3

`defineSettingsFrontComponent`, rendered inside *Settings → Applications → WhatsApp*.

**Connection card (per account)**

- Inputs: name, WABA ID, `phone_number_id`, default calling code, test-account toggle,
  auto-create-contacts toggle, throttle.
- **Test connection** → `wa-account-admin-route { action: 'test' }` performs a live
  `GET /{phone_number_id}` and stores display name, display number, quality and tier (FR-ACC-1).
- **Callback details** (FR-ACC-2): the exact URL to paste into Meta —
  `https://{origin}/whatsapp/webhook` (proxy alias) with `https://{origin}/webhooks/server/{LF_WEBHOOK_RESOLVER}`
  shown as the direct form, each with a copy button; the verify token is **not** displayed
  (it is a secret) — instead the card states "set as the `META_VERIFY_TOKEN` server variable" and
  shows whether it is configured.
- **Webhook status**: last handshake, last event received (relative), and the checklist of
  required subscribed fields (AR-10) as a copyable list.

**Health panel** (NFR-O3, FR-ACC-4)

| Row | Green when |
|---|---|
| Token | `tokenLastCheckedAt` < 2 h and last check succeeded |
| Webhook | `webhookLastEventAt` < staleness threshold |
| Quality | `green` |
| Tier | used < limit − reserve |
| Failed webhook events | zero unprocessed `failed` rows in 24 h |
| Stuck outbound | zero messages `queued` > 15 min |

Each red row states the remedy and links to the relevant runbook section (11).

**Templates tab** — synced templates with status, category, quality, the `publishedToCrm` toggle
(admin-only, FR-TPL-2), unsupported reasons, "Sync now", and the submission form (FR-TPL-6).

**Consent tab** — keyword lists, confirmation wording, and the consent import tool (06 §11).

**Diagnostics tab** — recent failed `whatsappWebhookEvent` rows with payload inspection and
replay (§12.4 of the TRD; see [11](11-observability-operations.md)); counters from the metrics
store; a "Send test message" box.

---

## 7. Command menu item — FR-UI-3

```ts
defineCommandMenuItem({
  universalIdentifier: CMI_OPEN_CHAT,
  label: msg('Open WhatsApp chat'),
  availabilityType: 'RECORD_SELECTION',
  availabilityObjectUniversalIdentifier: STANDARD_OBJECT.person.universalIdentifier,
  frontComponentUniversalIdentifier: FC_SIDE_PANEL_CHAT,
  conditionalAvailabilityExpression: 'numberOfSelectedRecords === 1',
});
```

`FC_SIDE_PANEL_CHAT` reads `useSelectedRecordIds()[0]`, calls
`GET /s/whatsapp/feed?scope=thread&by=person&id=<personId>`, and renders `<ThreadView>` — or an
empty state with "Iniciar conversa" (template picker) when the person has no thread yet.

---

## 8. Localisation (FR-UI-5)

- Every string goes through `t()`/`msg()`; `useLocale()` selects the catalog.
- Server responses carry machine codes only; the copy tables for policy denials, Meta errors
  (appendix B) and exclusion reasons live in `src/components/common/copy.ts` in pt and en.
- Dates and countdowns are formatted with `Intl` in `Africa/Luanda` by default, overridable by
  the workspace member's locale.
- `pt-PT` is the primary review target; strings are written pt-first and translated to en, not
  the reverse (the users are Portuguese-speaking — A-6).

---

## 9. Theming and accessibility

- Colours come from `useTheme()` (`twenty-ui/theme-constants`) — never hard-coded hexes — so
  light/dark follow the workspace. `useColorScheme()` covers the few places a token is missing.
- CSS is unscoped in this sandbox: **every** class name is prefixed `wa-`, and bare element
  selectors are forbidden (they would leak into Twenty's own DOM).
- Status is never conveyed by colour alone: ticks carry `aria-label`, the window chip carries
  text, failure carries an icon plus a message.
- All interactive elements are real `<button>`/`<a>` elements with `aria-label`s; focus order is
  DOM order because focus cannot be managed programmatically.

---

## 10. Graceful degradation (C-4, R-3)

Front components are documented by Twenty as under active development, and "advanced usages can
fail, often silently". Three fallback tiers, decided by probe P-6 in week 1:

| Tier | Trigger | Delivery |
|---|---|---|
| 1 — full | probe passes | as specified above |
| 2 — simplified | rich chat proves unstable in a widget | Person tab shows a read-only transcript plus a "Reply" button opening the side panel; the Inbox becomes a Twenty record view over `whatsappThread` with the chat in a side panel |
| 3 — minimum viable | widgets prove unusable | Inbox is a record view; all composing happens in the side panel; campaigns become a record view plus the builder in the settings surface |

Tier 2 and 3 keep every server-side requirement intact — only the presentation degrades. The
components are structured so the drop is a routing change, not a rewrite: `<ThreadView>`,
`<TemplatePicker>` and `<CampaignBuilder>` are plain React components with no dependency on which
of the five hosts renders them.

---

## 11. Requirement trace

| Requirement | Where |
|---|---|
| FR-UI-1 Person tab, history, ticks, media, composer | §1, §3 |
| FR-UI-2 Inbox with filters and unread badges | §4 |
| FR-UI-3 side-panel chat from any Person | §7 |
| FR-UI-4 polling transport with a seam for subscriptions | §2, D-6 |
| FR-UI-5 pt/en | §8 |
| FR-UI-6 countdown chip, quality banner, inline retry | §3.1, §3.2, §4 |
| FR-UI-7 desktop notifications, sound, emoji, snippets | MAY — emoji grid only; the rest deferred |
| FR-ACC-1/2 connection + callback details + verification status | §6 |
| FR-ACC-3/4 quality, tier, health | §6 health panel |
| FR-ACC-5 test-account badge | §4 banner, §6 |
| NFR-P4 50-message pages < 1 s | §3.1 |
| C-3/C-4/R-3 sandbox constraints and fallbacks | §3.1, §10 |
