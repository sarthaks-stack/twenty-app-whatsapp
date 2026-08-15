# 01 — Project layout & conventions

Implements AR-1, AR-2, AR-4, AR-5, NFR-M1, NFR-M2.

---

## 1. Directory structure

```
twenty-whatsapp/
├── src/
│   ├── application-config.ts              # defineApplication + serverVariables + applicationVariables
│   ├── default-role.ts                    # defineApplicationRole — the role logic functions run as
│   ├── roles/
│   │   ├── whatsapp-agent.role.ts
│   │   └── whatsapp-admin.role.ts
│   ├── constants/
│   │   ├── universal-identifiers.ts       # every hand-assigned v4 UUID (appendix C)
│   │   ├── field-identifiers.ts           # derived UUIDs via getFieldUniversalIdentifier
│   │   ├── config-defaults.ts             # throttles, intervals, ceilings, keyword lists
│   │   └── meta.ts                        # graph version default, endpoint paths, size caps
│   ├── objects/
│   │   ├── whatsapp-account.object.ts
│   │   ├── whatsapp-thread.object.ts
│   │   ├── whatsapp-message.object.ts
│   │   ├── whatsapp-template.object.ts
│   │   ├── whatsapp-consent-event.object.ts
│   │   ├── whatsapp-campaign.object.ts
│   │   ├── whatsapp-campaign-recipient.object.ts
│   │   └── whatsapp-webhook-event.object.ts
│   ├── fields/                            # relation fields (both sides) + Person extensions
│   │   ├── whatsapp-opt-in-status-on-person.field.ts
│   │   ├── threads-on-whatsapp-account.field.ts
│   │   ├── account-on-whatsapp-thread.field.ts
│   │   └── …                              # see 02-data-model.md § Relation inventory
│   ├── indexes/
│   │   └── whatsapp.indexes.ts            # defineIndex × 8
│   ├── logic-functions/
│   │   ├── wa-webhook-resolver.ts         # serverRouteTrigger
│   │   ├── wa-webhook-verify.ts           # httpRouteTrigger GET, isAuthRequired:false
│   │   ├── wa-webhook-ingest.ts
│   │   ├── wa-inbound-processor.ts
│   │   ├── wa-status-processor.ts
│   │   ├── wa-template-event.ts
│   │   ├── wa-account-event.ts
│   │   ├── wa-media-worker.ts
│   │   ├── wa-outbound-sender.ts
│   │   ├── wa-send-message-route.ts       # httpRouteTrigger POST
│   │   ├── wa-send-template-action.ts     # workflowActionTrigger
│   │   ├── wa-template-sync.ts            # cronTrigger + invoked
│   │   ├── wa-window-sweeper.ts           # cronTrigger
│   │   ├── wa-health-check.ts             # cronTrigger
│   │   ├── wa-campaign-snapshot.ts
│   │   ├── wa-campaign-runner.ts          # cronTrigger
│   │   ├── wa-campaign-control.ts         # httpRouteTrigger POST
│   │   ├── wa-account-admin-route.ts      # httpRouteTrigger POST
│   │   ├── wa-thread-actions-route.ts     # httpRouteTrigger POST
│   │   ├── wa-consent-route.ts            # httpRouteTrigger POST
│   │   ├── wa-inbox-feed-route.ts         # httpRouteTrigger GET
│   │   ├── wa-stats-rollup.ts             # cronTrigger
│   │   ├── wa-retention-purge.ts          # cronTrigger
│   │   ├── wa-webhook-replay-route.ts     # httpRouteTrigger POST
│   │   ├── post-install.ts
│   │   └── uninstall.ts
│   ├── domain/                            # pure, dependency-free, unit-tested business logic
│   │   ├── policy/                        # AR-17 — the single policy module
│   │   │   ├── service-window.ts
│   │   │   ├── send-permission.ts
│   │   │   └── template-rules.ts
│   │   ├── phone/
│   │   │   ├── normalise.ts
│   │   │   └── country-variants.ts
│   │   ├── status-machine.ts              # AR-9
│   │   ├── dedup-key.ts
│   │   ├── template-render.ts             # {{n}} binding + component payload builder
│   │   ├── campaign-exclusions.ts
│   │   ├── tier-budget.ts
│   │   ├── circuit-breaker.ts
│   │   ├── pacing.ts                      # D-5 slot computation
│   │   └── cost.ts                        # rate card maths
│   ├── providers/
│   │   └── whatsapp/
│   │       ├── types.ts                   # WhatsAppProvider + payload types
│   │       ├── cloud-api.provider.ts      # the only implementation (D-14)
│   │       ├── errors.ts                  # Meta error catalog mapping (appendix B)
│   │       └── index.ts                   # getProvider()
│   ├── server/                            # shared helpers usable only in logic functions
│   │   ├── clients.ts                     # memoised CoreApiClient / MetadataApiClient
│   │   ├── repositories/                  # one module per object: typed CRUD + batching
│   │   ├── logger.ts                      # structured logging + secret redaction (SEC-1)
│   │   ├── metrics.ts                     # kv-backed counters (NFR-O2)
│   │   ├── auth.ts                        # server-side role re-check (SEC-5)
│   │   └── batching.ts                    # ≤60-record chunking + adaptive backoff (NFR-R2)
│   ├── front-components/
│   │   ├── wa-person-thread.tsx
│   │   ├── wa-side-panel-chat.tsx
│   │   ├── wa-inbox.tsx
│   │   ├── wa-campaigns.tsx
│   │   └── wa-settings.tsx                # defineSettingsFrontComponent
│   ├── components/                        # shared React, NOT registered as front components
│   │   ├── chat/                          # ThreadView, MessageBubble, Composer, WindowChip…
│   │   ├── templates/                     # TemplatePicker, VariableForm, TemplatePreview
│   │   ├── campaigns/                     # Builder steps, PreflightPanel, StatsPanel
│   │   └── common/                        # StatusTicks, EmptyState, ErrorBanner, useFeed
│   ├── page-layouts/
│   │   ├── whatsapp-inbox.page-layout.ts
│   │   └── whatsapp-campaigns.page-layout.ts
│   ├── page-layout-tabs/
│   │   └── person-whatsapp.page-layout-tab.ts
│   ├── navigation-menu-items/
│   │   ├── whatsapp-inbox.navigation-menu-item.ts
│   │   └── whatsapp-campaigns.navigation-menu-item.ts
│   ├── command-menu-items/
│   │   └── open-whatsapp-chat.command-menu-item.ts
│   ├── views/                             # admin-facing record views (each paired with a nav item)
│   └── __tests__/
│       ├── global-setup.ts                # scaffolded — unchanged
│       ├── fixtures/meta/                 # recorded webhook payloads (see 12-testing.md)
│       └── *.integration-test.ts
├── locales/                               # pt / en catalogs (yarn twenty dev:translations-extract)
├── public/                                # logo.svg + gallery images
└── specs/                                 # this folder
```

### Layering rules (enforced by lint, see §6)

| Layer | May import | Must not import |
|---|---|---|
| `src/domain/**` | nothing but `libphonenumber-js`, node builtins | SDK clients, `src/server`, `src/providers` |
| `src/providers/**` | `src/domain`, node builtins, `process.env` | `src/server/repositories`, React |
| `src/server/**` | `src/domain`, `src/providers`, SDK clients | React, `src/front-components` |
| `src/logic-functions/**` | everything server-side | React, `src/components` |
| `src/components/**`, `src/front-components/**` | `src/domain` (pure only), `twenty-ui`, SDK front APIs | `src/server`, `src/providers`, node builtins |

`src/domain` being import-free is what makes the policy module (AR-17), the status machine
(AR-9), phone normalisation (FR-CID-1/2) and the exclusion matrix (FR-CAM-3) unit-testable
without a running Twenty server — the bulk of the test plan lives there.

---

## 2. Naming conventions

| Entity | File | `name` value | Example |
|---|---|---|---|
| Object | `kebab-case.object.ts` | camelCase singular/plural | `whatsappMessage` / `whatsappMessages` |
| Relation field | `<field>-on-<owner>.field.ts` | camelCase | `account-on-whatsapp-thread.field.ts` → `account` |
| Logic function | `wa-<verb-noun>.ts` | same as file, no extension | `wa-inbound-processor` |
| Front component | `wa-<surface>.tsx` | same as file | `wa-inbox` |
| kv key | `wa:<domain>:<id>` | — | `wa:phone-number:123456789` |
| Metric counter | `wa.<area>.<event>` | — | `wa.inbound.dedup_hit` |
| Timeline activity | `whatsapp.<entity>.<event>` | — | `whatsapp.message.received` |

All object names are prefixed `whatsapp` so they group in the Twenty object list and cannot
collide with another app's objects.

---

## 3. Universal identifier strategy (AR-4)

Two tiers, per D-11:

**Tier 1 — hand-assigned v4 UUIDs** for objects, logic functions, front components, page
layouts, tabs, widgets, navigation items, command menu items, roles and indexes. All live in
`src/constants/universal-identifiers.ts` and are listed in
[appendix-c-uuid-registry.md](appendix-c-uuid-registry.md). **Never regenerate one** — changing
an identifier orphans production data.

**Tier 2 — derived v5 UUIDs** for every field:

```ts
// src/constants/field-identifiers.ts
import { getFieldUniversalIdentifier } from 'twenty-sdk/define';
import { APPLICATION_UNIVERSAL_IDENTIFIER, OBJ_MESSAGE } from './universal-identifiers';

export const fieldId = (objectUniversalIdentifier: string, name: string) =>
  getFieldUniversalIdentifier({
    applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
    objectUniversalIdentifier,
    name,
  });

export const WA_MESSAGE_WAMID_FIELD_ID = fieldId(OBJ_MESSAGE, 'wamid');
export const WA_MESSAGE_MEDIA_FILE_FIELD_ID = fieldId(OBJ_MESSAGE, 'mediaFile');
// …
```

Consequence: **renaming a field changes its identifier and drops the column.** Field renames are
therefore a migration, handled by adding the new field, backfilling in a post-install hook, and
marking the old one deprecated — never an in-place rename.

Fields added to standard objects (Person) also use `fieldId(STANDARD_OBJECT.person.universalIdentifier, 'whatsappOptInStatus')`.

---

## 4. Configuration (NFR-M1)

Nothing operationally tunable is a code literal. Two mechanisms:

### 4.1 `serverVariables` — secrets and instance credentials (AR-2, SEC-1)

Declared in `src/application-config.ts`; filled in by the operator at *Settings → Applications →
WhatsApp*; injected into logic functions as `process.env.<NAME>`; **never** reach front
components.

| Name | Secret | Required | Description |
|---|---|---|---|
| `META_APP_ID` | no | yes | Meta app ID; shown in the settings health panel |
| `META_APP_SECRET` | **yes** | yes | HMAC key for `X-Hub-Signature-256` |
| `META_ACCESS_TOKEN` | **yes** | yes | System User token, scopes `whatsapp_business_messaging` + `whatsapp_business_management` |
| `META_VERIFY_TOKEN` | **yes** | yes | Random string echoed during the GET handshake |

Every read goes through a single accessor that fails closed:

```ts
// src/providers/whatsapp/config.ts
export const requireSecret = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MissingConfigurationError(name); // mapped to a specific admin-facing message
  }
  return value.trim();
};
```

No fallback to `''`, no default token, ever (SEC-1).

### 4.2 `applicationVariables` — non-secret tunables

Have manifest defaults, are editable by the operator, and are readable from front components via
`getApplicationVariable()` (always as strings — parse explicitly).

| Name | Type | Default | Used by |
|---|---|---|---|
| `META_GRAPH_VERSION` | TEXT | `v26.0` | provider (C-7) |
| `WA_DEFAULT_COUNTRY_CALLING_CODE` | TEXT | `+244` | phone normalisation (FR-CID-1) |
| `WA_SEND_THROTTLE_PER_SECOND` | NUMBER | `20` | pacing (AR-12) |
| `WA_INTERACTIVE_LANE_SHARE` | NUMBER | `0.4` | lane split (D-5) |
| `WA_RECIPIENT_MIN_SPACING_MS` | NUMBER | `250` | 131056 avoidance |
| `WA_MEDIA_AUTO_DOWNLOAD_MAX_BYTES` | NUMBER | `26214400` | media worker (D-8) |
| `WA_SERVICE_WINDOW_HOURS` | NUMBER | `24` | policy module |
| `WA_FEP_WINDOW_HOURS` | NUMBER | `72` | policy module (FR-IN-6) |
| `WA_OPT_OUT_KEYWORDS` | ARRAY | `["STOP","SAIR","PARAR","CANCELAR"]` | FR-CON-3 |
| `WA_OPT_IN_KEYWORDS` | ARRAY | `["START","INICIAR","SIM"]` | FR-CON-3 |
| `WA_POLL_INTERVAL_THREAD_MS` | NUMBER | `3000` | D-6 |
| `WA_POLL_INTERVAL_INBOX_MS` | NUMBER | `8000` | D-6 |
| `WA_POLL_INTERVAL_BLURRED_MS` | NUMBER | `20000` | D-6 |
| `WA_CAMPAIGN_BATCH_SIZE` | NUMBER | `200` | AR-20 |
| `WA_CAMPAIGN_TIER_RESERVE_PCT` | NUMBER | `10` | AR-21 |
| `WA_CAMPAIGN_FAILURE_WINDOW` | NUMBER | `100` | AR-22 |
| `WA_CAMPAIGN_MAX_FAILURE_RATE_PCT` | NUMBER | `10` | AR-22 |
| `WA_RETENTION_WEBHOOK_EVENT_DAYS` | NUMBER | `30` | §8.8 |
| `WA_RETENTION_MESSAGE_MONTHS` | NUMBER | `0` (unlimited) | SEC-9 |
| `WA_RATE_MARKETING_USD` | NUMBER | `0.0225` | cost model (Q-1) |
| `WA_RATE_UTILITY_USD` | NUMBER | `0.0040` | cost model (Q-1) |
| `WA_RATE_AUTHENTICATION_USD` | NUMBER | `0.0040` | cost model (Q-1) |
| `WA_PROVIDER` | SELECT | `cloud-api` | provider factory (D-14) |

Per-account overrides that must differ between numbers (`sendThrottlePerSecond`,
`defaultCountryCallingCode`, `contactAutoCreationEnabled`, `isTestAccount`) are **record fields**
on `whatsappAccount`, not application variables (FR-ACC-6). Resolution order is
*account field → application variable → constant default*, implemented once in
`src/server/config.ts`.

---

## 5. Install hooks (AR-5)

**`post-install.ts`** (`definePostInstallLogicFunction`, `shouldRunOnVersionUpgrade: true`,
`shouldRunSynchronously: false`) is idempotent and:

1. Seeds nothing that the operator must own — it does **not** invent a `whatsappAccount`.
2. Ensures the two app roles exist and, on first install only, assigns the installing user to
   *WhatsApp Admin*.
3. Writes a KV marker `wa:schema-version` and runs version-gated backfills (currently none).
4. Logs the callback URL and the required webhook field list so it appears in function logs for
   the operator.

**`uninstall.ts`** (`defineUninstallLogicFunction`):

1. Deletes every `wa:phone-number:*` / `wa:waba:*` SERVER-scoped kv claim owned by this
   workspace so a reinstall elsewhere can claim the number (mirrors the Slack disconnect hook).
2. Leaves records in place — uninstall must not destroy conversation history. Deletion is an
   explicit admin action (SEC-8).

---

## 6. Lint, typecheck, test, CI

Existing scripts stay (`lint`, `typecheck`, `test`, `test:unit`). Additions:

- **oxlint rules** (`.oxlintrc.json`):
  - `no-restricted-imports` encoding the layering table in §1.
  - `no-restricted-syntax` banning the literal `graph.facebook.com` outside `src/providers/`
    (enforces AR-11/D-14 — one send path).
  - ban `console.*` outside `src/server/logger.ts` (forces redaction, SEC-1).
- **`yarn test:unit`** runs `src/**/*.test.ts` — the whole `src/domain` tree, no server needed.
  This is the gate that must stay under ~10 s so it runs on every save.
- **`yarn test`** runs `*.integration-test.ts` against a live Twenty via the scaffolded
  `global-setup.ts`.
- **CI** (`.github/workflows/ci.yml`): lint → typecheck → unit → integration against the pinned
  Twenty image.
- **Weekly upgrade CI** (new workflow `compat.yml`, NFR-M2 / R-2): scheduled job installing the
  app on `twentycrm/twenty:latest`, running the integration smoke suite, and opening an issue on
  failure. The production instance stays pinned to the last version this job passed on.

---

## 7. Localisation (FR-UI-5, A-6)

- All user-facing strings in front components go through `t()` / `msg()` from
  `twenty-sdk/front-component`.
- Server-side strings that reach the UI (Meta error explanations, exclusion reasons, campaign
  status labels) are **not** translated on the server. Logic functions return stable machine
  codes (`errorCode: '131047'`, `exclusionReason: 'no_consent'`) and the front components own the
  copy. This keeps appendix B as a data table and makes pt/en a front-end-only concern.
- `yarn twenty dev:translations-extract` populates `locales/en` and `locales/pt-PT`.
  `pt-PT` is the primary review target (A-6); `pt-BR` is a MAY.
