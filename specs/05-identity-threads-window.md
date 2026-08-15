# 05 — Identity, threads and the service window

Implements FR-CID-1 … FR-CID-6, FR-THR-1 … FR-THR-6, FR-IN-3, FR-IN-6, AR-17.

---

## 1. Phone normalisation (`src/domain/phone/`) — FR-CID-1

Pure, dependency-light (`libphonenumber-js`, already a transitive dependency of `twenty-sdk`),
100 % unit-tested. Two directions:

```ts
// A CRM-side value (any format) → canonical E.164 with '+'
export const toE164 = (raw: string, defaultCallingCode: string): string | null;

// A Meta wa_id (digits, no '+') → canonical E.164
export const waIdToE164 = (waId: string): string | null;

// The set of E.164 strings that could legitimately denote the same subscriber
export const identityCandidates = (e164: string): string[];
```

Rules:

1. Strip everything but digits and a leading `+`.
2. If there is no `+` and no leading country code, apply the account's
   `defaultCountryCallingCode` (default `+244`, Angola — A-6).
3. Parse with `libphonenumber-js`; reject anything not `isValid()`.
4. Return `+` + country code + national number.

### 1.1 Country variants (FR-CID-2) — `country-variants.ts`

`wa_id` is *usually* the E.164 number without `+`, but three markets break that assumption. The
matcher must generate every candidate **before** declaring a number unknown:

| Market | Divergence | Candidates generated |
|---|---|---|
| **Brazil (+55)** | Mobile numbers have a 9th digit that WhatsApp may omit in `wa_id` | both 12-digit (`55 DD 8 digits`) and 13-digit (`55 DD 9 8 digits`) forms |
| **Argentina (+54)** | Mobile requires a `9` after the country code for international dialling; `wa_id` may include or omit it | with and without the `9` infix |
| **Mexico (+52)** | Legacy `1` prefix after the country code (`521…`) still appears | with and without the `1` |
| Everything else | none | the single canonical form |

```ts
identityCandidates('+5511987654321')  // → ['+5511987654321', '+551187654321']
identityCandidates('+5491123456789')  // → ['+5491123456789', '+541123456789']
identityCandidates('+5215512345678')  // → ['+5215512345678', '+525512345678']
identityCandidates('+244923000000')   // → ['+244923000000']
```

This function is the sole source of variant knowledge; the matcher, the campaign de-duplicator
and the outbound `to` resolution all call it. The unit-test matrix in
[12-testing.md](12-testing.md) enumerates AO, PT, BR, AR, MX cases in both directions.

`whatsappThread.waId` always stores **Meta's exact string**, and `dialablePhone` stores our
canonical E.164. Sends use `waId` (04 §6); dialling/display uses `dialablePhone`.

---

## 2. Contact matching (`src/server/matching.ts`) — FR-CID-3, FR-CID-5

Called by `wa-inbound-processor` (03 §4 step 4) and by the campaign snapshot in reverse.

```
matchPerson(waId, account):
  candidates = identityCandidates(waIdToE164(waId))
  people = searchPeopleByPhones(candidates)          # primaryPhoneNumber + additionalPhones
  switch people.length:
    0 -> account.contactAutoCreationEnabled ? createPerson() : null (thread stays unlinked)
    1 -> link
    n -> thread.status = 'needs_review'
         thread.linkCandidates = people.map(id, name, phone)
         thread.person = null
         counter wa.inbound.needs_review
```

### 2.1 Searching by phone

Twenty's `PHONES` composite exposes `primaryPhoneNumber` / `primaryPhoneCallingCode` as filterable
sub-fields, and `additionalPhones` as JSON. The specified query strategy:

1. One `people` query filtering `primaryPhoneNumber` `IN` the national-number forms of the
   candidates **and** `primaryPhoneCallingCode` `IN` the calling codes. Indexed, cheap, catches
   the overwhelming majority.
2. If that returns nothing, a second pass over `additionalPhones` using `CONTAINS` on the
   national number. Unindexed and therefore only a fallback.

**PROBE P-5**: confirm that `additionalPhones` is filterable through the Core API on the target
version. Fallback if not: maintain a derived, indexed `whatsappSearchablePhones` `ARRAY` field on
Person, populated by a `person.created`/`person.updated` database-event function and a one-time
backfill in the post-install hook. Specified but not built unless the probe fails.

### 2.2 Auto-creation (FR-CID-3)

```ts
createPerson({
  name: splitProfileName(profileName),                 // best-effort first/last; whole string → firstName
  phones: {
    primaryPhoneNumber: nationalNumber,
    primaryPhoneCallingCode: `+${countryCode}`,
    primaryPhoneCountryCode: regionCode,               // e.g. 'AO'
  },
  whatsappOptInStatus: 'unknown',                      // never 'opted_in' — inbound contact ≠ marketing consent
  createdBy: { source: 'MANUAL', name: 'WhatsApp' },   // ACTOR attribution, FR-CID-3
});
```

Two rules that matter more than they look:

- A person created from an inbound message is **`unknown`**, never `opted_in`. Someone messaging
  support has not consented to marketing (FR-CAM-5, R-11). Treating inbound contact as consent is
  the single fastest route to a RED quality rating.
- Auto-creation is per-account (`contactAutoCreationEnabled`) so a test number can be prevented
  from polluting the CRM (FR-ACC-5).

Race: two inbound messages from a new number arriving simultaneously could create two Persons.
Mitigated by the thread being the uniqueness anchor — `upsertThread` (§3) runs first and is
protected by `IDX_THREAD_ACCOUNT_WAID`; the loser of the race re-reads the thread and reuses its
person.

### 2.3 Disambiguation UI (FR-CID-5)

A `needs_review` thread renders a banner in the chat panel listing `linkCandidates` with
"This is …" buttons plus "Create a new contact". Selecting one calls
`wa-thread-actions-route { action: 'link', personId }`. Messages keep arriving into the thread
meanwhile — review blocks *attribution*, never *ingestion*.

### 2.4 Re-linking (FR-CID-4)

`wa-thread-actions-route { action: 'relink', personId | null }`:

- moves `thread.person`, leaving all messages attached to the thread (history follows the thread,
  as required);
- writes a timeline activity `whatsapp.thread.relinked` on both the old and the new Person, with
  the actor;
- **does not** retroactively rewrite campaign recipient rows — those record who was targeted at
  snapshot time and must stay immutable for audit.

---

## 3. Thread lifecycle (FR-THR-1 … FR-THR-6)

### 3.1 `upsertThread` — the FR-THR-1 guarantee

```ts
const upsertThread = async (account, waId, profileName) => {
  const existing = await findThread(account.id, waId);
  if (existing) return maybeRefreshProfileName(existing, profileName);
  try {
    return await createThread({ account, waId, dialablePhone: waIdToE164(waId), profileName,
                                status: 'open', windowState: 'expired', unreadCount: 0 });
  } catch (e) {
    if (isUniqueViolation(e)) return findThread(account.id, waId);   // concurrent creation
    throw e;
  }
};
```

Every entry point — inbound, campaign send, workflow action, rep-initiated template, side-panel
"start a chat" — calls this one function. That is the mechanical guarantee behind FR-OUT-5 and
the explicit avoidance of Chatwoot #14086 (duplicate conversations for template sends).

### 3.2 Status transitions (FR-THR-2)

| From | Event | To |
|---|---|---|
| any | inbound message | `open` |
| `open` | outbound message sent | `awaiting_reply` |
| `awaiting_reply` | inbound message | `open` |
| any | rep clicks Close | `closed` |
| `closed` | inbound message | `open` (a new inbound always reopens — FR-THR-2) |
| any | ambiguous match | `needs_review` |
| `needs_review` | link resolved | `open` |

`closed` is a CRM label only. It has no effect on Meta, on the service window, or on the ability
to send — it exists so an inbox filter can hide handled conversations.

Auto-close after N days of silence is **OPEN (Q-3)**. The sweeper is written so that enabling it
is a config change (`WA_AUTO_CLOSE_DAYS`, default `0` = disabled), not new code.

### 3.3 Assignment (FR-THR-3, FR-THR-4)

- Manual: `wa-thread-actions-route { action: 'assign', assigneeId }` from the inbox or the thread
  header. Writes a timeline activity `whatsapp.thread.assigned` (audit, SEC-10).
- Round-robin (FR-THR-4, SHOULD): when `account.autoAssignStrategy === 'round_robin'` and a new
  thread is created by an inbound message, assign
  `account.assignmentMemberIds[(account.lastAssignedIndex + 1) % n]` and advance the index.
  Both fields are on the account record, so the increment has a single writer (the inbound
  processor) per account — no contention beyond what the pacing cursors already accept.
- Unassigned threads are visible via the inbox's `unassigned` filter.

> **Why an `ARRAY` of member ids rather than a relation for the agent group.** A many-to-many
> between `whatsappAccount` and `workspaceMember` would need a join object with no other purpose,
> and Twenty's app SDK models relations as one-to-many/many-to-one pairs. An `ARRAY` of UUIDs
> edited from the settings UI is a deliberate simplification; the cost is no referential
> integrity when a member is deactivated, handled by filtering the list against active members at
> assignment time.

### 3.4 `wa-window-sweeper` (FR-THR-5)

`cronTriggerSettings: { pattern: '*/15 * * * *' }` · `timeoutSeconds: 60`

```
threads where windowState = 'open' and serviceWindowExpiresAt < now
  -> patch windowState = 'expired'      (batched, ≤60 per call)
```

Purely a cache refresh so list filters and the composer react without new events. The server
never trusts it for a send decision (04 §1.1). Cost is bounded: at 100 000 threads only those
expiring in the last 15 minutes are touched.

### 3.5 Free Entry Point windows (FR-IN-6)

When an inbound message carries `referral` (a Click-to-WhatsApp ad or Page CTA):

- store the whole `referral` object on the thread;
- set `windowKind = 'free_entry_point'`, so `computeWindowExpiry` uses 72 h;
- render a "Veio de anúncio" chip on the thread with the ad headline and source URL.

Subsequent non-referral inbound messages reset `windowKind` to `standard` and the window to 24 h
from that message — the FEP grace is tied to the referral conversation, not to the contact
forever.

### 3.6 Internal notes and snooze (FR-THR-6, MAY)

Not modelled as `whatsappMessage` rows (they would pollute the message table, the exports and the
counts). Implemented, if capacity allows, as standard Twenty **Notes** with a note target on the
Person, created from the chat panel with a `#whatsapp` tag. Zero new schema. Snooze is
`thread.snoozedUntil` (`DATE_TIME`) plus an inbox filter — one field, added only if the item is
picked up.

---

## 4. The inbox query

The inbox (FR-UI-2) and the feed route share one query shape, and it is the reason
`IDX_THREAD_ACCOUNT_WAID` is not sufficient on its own:

```
threads
  where accountId in (visible accounts)
    and (filter: assigneeId = me | assigneeId is null | any)
    and (filter: status in (...) | windowState = 'open' | serviceWindowExpiresAt < now + 1h)
  order by lastMessageAt desc
  limit 50
```

`lastMessageAt` is denormalised on the thread precisely so this sort never touches
`whatsappMessage`. Keeping it accurate is the inbound processor's and the sender's
responsibility, both of which already write the thread in the same operation.

---

## 5. Requirement trace

| Requirement | Where |
|---|---|
| FR-CID-1 normalisation with +244 default | §1 |
| FR-CID-2 BR/AR/MX variants, `waId` stored separately | §1.1 |
| FR-CID-3 auto-create with ACTOR attribution, per-account toggle | §2.2 |
| FR-CID-4 re-link, history follows the thread | §2.4 |
| FR-CID-5 needs-review instead of guessing | §2 / §2.3 |
| FR-CID-6 company roll-up | view over `whatsappThread` filtered by `person.company` (02 §9) |
| FR-THR-1 one thread per (account, waId) | §3.1 |
| FR-THR-2 assignee/status/unread/preview/expiry, reopen on inbound | 02 §2, §3.2 |
| FR-THR-3 manual assignment, audited | §3.3 |
| FR-THR-4 round-robin + unassigned filter | §3.3 |
| FR-THR-5 15-minute sweeper | §3.4 |
| FR-THR-6 notes/snooze | §3.6 (MAY) |
| FR-IN-3 window refresh on inbound | 03 §4 step 8 |
| FR-IN-6 FEP 72 h | §3.5 |
