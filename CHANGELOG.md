# Changelog

All notable changes to this application are documented in this file.

## Unreleased — phase 10: automation, operations, release

The operational tail. Everything in phases 0–10 that is code is now written; what remains before
the release gate is the human-run part, scripted in
[specs/16-release-checklist.md](specs/16-release-checklist.md).

### Added

- **`wa-send-template-action`** — "Send WhatsApp template" as a workflow step (FR-WF-1). A policy
  denial is a *result* (`status: 'denied'` with a machine reason) so an automation can branch on
  it; only infrastructure failures throw. It reuses the same policy gate as a rep's send, which is
  what makes FR-CON-4 true by construction. `domain/workflow-parameters.ts` binds a workflow
  author's free-form `Variables` object onto the template's spec.
- **`wa-webhook-replay-route`** (`POST /s/whatsapp/replay`, admin-only) — list the raw log, replay
  selected events, replay everything failed in a range behind a counted confirmation, or resync one
  conversation. Re-enqueues through the live fan-out, never a replay-only copy of it. Wired into
  Settings → Diagnostics.
- **`wa-retention-purge`** (daily, 03:00) — destroys expired raw webhook events, empties message
  content past the retention window while keeping status and cost, and expires metric counters on a
  fixed 90 days (SEC-9).
- **`post-install` / `uninstall` hooks** (AR-5) — post-install verifies the app roles, re-asserts
  routing claims for connected numbers, records a schema version and logs the Meta callback URL;
  uninstall releases this workspace's claims so the numbers can be connected again, and destroys
  nothing.
- **Default notification workflow provisioning** (D-10 layer 3) — one click creates the workflow,
  its trigger and a Task step as a draft, and names the two decisions left to the operator.
- **`.github/workflows/compat.yml`** — weekly run against `twentycrm/twenty:latest`, opening or
  commenting on a single `twenty-compat` issue on failure (NFR-M2, R-2).
- **Load tests** at the spec's own numbers — 3 000 deliveries keyed and routed, a sliding
  one-second window over the pacing plan, the two-cursor guarantee at a 10 000-recipient campaign,
  a 100 000-recipient snapshot.
- **The security review as tests** — the route role matrix as data (a new route with no reviewed
  entry fails the build), the consent block as an exhaustive matrix, and a secret scan over
  browser-reachable source and the built bundles.
- **`specs/16-release-checklist.md`** — the signed, human-run gate: install rehearsal, the
  thirteen-step handset loop, nine operational procedures, and the load run on real infrastructure.

### Changed

- **The workflow step is configurable from the builder.** `WhatsApp account` and `Template` were
  text boxes — an author had to paste a WABA id and a template id by hand. Both are now `record`
  pickers over `whatsappAccount` and `whatsappTemplate`, listing the real rows by name, which works
  because those are ordinary Twenty objects.
- **Template variables are five labelled fields** (`Variable {{1}}` … `{{5}}`), each a plain string
  so each takes an `(x)` workflow variable, plus an `Advanced` JSON field for a header image, a
  button URL or a named variable. Twenty cannot load a template's variables on demand — the input
  schema is in the manifest and nothing recomputes it from a half-filled step — so a fixed set of
  fields is as close to field-by-field as the platform allows. Field order is controlled through the
  property *names*, because step inputs are stored as `jsonb`, whose keys order by length.
- **The app logo is WhatsApp's mark**, at `public/logo-whatsapp.svg`. Twenty renders the
  *application* logo in every workflow step header, so `workflowActionTriggerSettings.icon` was never
  going to appear there and the four grey squares were what an author saw above "Send WhatsApp
  template". The filename carries the cache bust: public assets are served with
  `max-age=3600` and no content hash, so replacing the bytes in place left browsers showing the old
  icon for an hour while the server served the new one.

### Fixed (found while doing the above)

- **A number bound nothing on a template with named placeholders.** `{ "1": "Ana" }` against
  `{{nome}}` resolved to empty, which meant the step's numbered variable fields — which can only
  send positions — silently failed for every named template. `bodyValueFor` now falls back to the
  1-based position. It failed safe (an unbound variable refuses the send) and was caught by a test
  rather than by the UI.
- **CI is pinned.** `.twenty-version` holds the Twenty version production runs and `ci.yml` reads
  it, so a pull request no longer fails because Twenty shipped upstream this morning. Watching
  `latest` is `compat.yml`'s job.
- `REQUIRED_WEBHOOK_FIELDS` is named once in `domain/constants.ts` — the settings card and the
  post-install log read the same list, so they cannot tell an operator two different things.
- Corrected the route registry: `/whatsapp/template` is singular, and `/whatsapp/upload` and
  `/whatsapp/replay` were missing from appendix C and from the specs/10 role matrix.
- specs/10 §3.4 now records that an API key is **refused** by default rather than treated as an
  admin, which is what the code does and why.

### Fixed

- `yarn typecheck` failed on `import 'twenty-ui/style.css'` — required at runtime, untyped by the
  package. Declared in `src/types/css-modules.d.ts`; the build is green again.

## 0.1.0

- Initial application scaffolded with [`create-twenty-app`](https://www.npmjs.com/package/create-twenty-app)
