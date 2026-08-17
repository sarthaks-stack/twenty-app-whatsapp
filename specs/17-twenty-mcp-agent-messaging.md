# 17 — Twenty MCP agent messaging

**Status: SPECIFIED**, with the two release probes in §12. Implements FR-MCP-1 … FR-MCP-7,
SEC-MCP-1 … SEC-MCP-5 and NFR-MCP-1 … NFR-MCP-3. Depends on AR-11, AR-17, D-22, D-25,
D-26, D-54, 04 §1–4, 05 §2, 06 §2–3/§9–12 and 10 §3/§5.

The capability lets an AI agent connected through **Twenty's own MCP server** find a Person using
Twenty's record tools, discover the WhatsApp templates that are safe to send to that Person, and
queue one selected template. MCP is the orchestration surface; this app remains the policy,
idempotency, audit and delivery boundary. No MCP caller talks to Meta and no MCP caller creates a
`whatsappMessage` record directly.

The design is grounded in `twenty-sdk@2.31.0` installed in this repository. In that SDK,
`toolTriggerSettings` exposes a logic function to Twenty chat, MCP and function calling, accepts a
standard JSON input schema, and has no declared output-schema or forwarded-caller-header surface.

---

## 1. Product contract

### 1.1 Agent journey

```text
user request
    │
    ▼
Twenty MCP record tools ──► uniquely resolve Person
    │
    ▼
whatsapp-list-sendable-templates ──► eligible templates + required variables
    │
    ▼
agent selects purpose/language and binds variables
    │
    ▼
whatsapp-send-template ──► policy + idempotency + audit + interactive queue
    │
    ▼
wa-outbound-sender ──► Meta WhatsApp Cloud API
```

Normative behaviour:

1. The agent uses Twenty MCP's schema-generated Person tools to search and read CRM contacts
   (FR-MCP-1). This app does **not** ship a second contact-search implementation.
2. A send requires one unambiguous `personId`. The send tool accepts neither a raw phone number nor
   a name/email query; the agent must clarify multiple matches rather than guess (SEC-MCP-1).
3. The agent calls `whatsapp-list-sendable-templates` for that Person before choosing a template.
4. Discovery returns only templates that are `APPROVED`, `publishedToCrm === true` and
   `isUsableInCrm === true`, and that pass the current 1:1 policy gate (FR-MCP-2).
5. The agent chooses the language and business purpose; the server never picks the first template
   or silently chooses between two languages with the same name.
6. The agent calls `whatsapp-send-template` with the Person id, exact template id, required values
   and a UUID-v4 `requestId` (FR-MCP-3/5).
7. The server resolves every record again and re-runs the policy gate immediately before queueing.
   Discovery is advisory, never an authorisation cache (SEC-MCP-2).
8. `status: 'accepted'` means the app queued the message; it does **not** mean Meta accepted,
   delivered or read it. Those states continue through the existing webhook pipeline.

### 1.2 Deliberate non-goals

- No free-form WhatsApp sends from MCP.
- No campaign creation, launch or bulk recipient iteration from these tools.
- No template publishing, submission, editing or synchronisation from MCP.
- No raw phone-number recipient input.
- No direct `whatsappMessage` create/update permission.
- No agent-authored template body or substitution of an unpublished template.
- No new MCP server and no fork of Twenty core.

---

## 2. Requirements

| ID | Requirement |
|---|---|
| FR-MCP-1 | The agent can use ordinary Twenty MCP record tools to find and disambiguate a Person. |
| FR-MCP-2 | The app exposes a read-only tool that lists only currently sendable, published and approved templates for one Person/account. |
| FR-MCP-3 | The app exposes a side-effecting tool that queues exactly one chosen template to one Person. |
| FR-MCP-4 | MCP sends use the same identity resolution, thread upsert, parameter validation, policy gate, scheduler and outbound worker as UI/workflow sends. |
| FR-MCP-5 | A retried tool call with the same UUID-v4 `requestId` returns the original message and never queues a duplicate. |
| FR-MCP-6 | The transcript and audit log distinguish an AI-agent send from a human-agent, workflow and campaign send. |
| FR-MCP-7 | Tool results are structured, machine-readable and explicit about denial, replay and eventual delivery. |
| SEC-MCP-1 | The send tool accepts a `personId`, never a phone number, name, email or arbitrary recipient. |
| SEC-MCP-2 | No discovery result or caller assertion can bypass the send-time server policy gate. |
| SEC-MCP-3 | MCP cannot publish templates, override consent/blocking/account health, or request free-form content. |
| SEC-MCP-4 | Tool execution is available only through a Twenty MCP credential/agent role authorised for WhatsApp and Person/template read. |
| SEC-MCP-5 | Caller/agent identity is never accepted as a tool argument; only platform-authenticated identity may populate `sentBy` or audit actor fields. |
| NFR-MCP-1 | Template discovery returns at most 50 rows per page and uses an opaque cursor. |
| NFR-MCP-2 | A successful send tool call queues through the interactive lane within 3 seconds p95, excluding later Meta delivery. |
| NFR-MCP-3 | Tool descriptions and result codes are stable API contracts; wording may improve, but names, field meanings and denial codes do not drift without a versioned change. |

---

## 3. Platform surface and entity layout

Create both logic functions with `yarn twenty dev:add logicFunction`, then replace the scaffolded
identifiers with the permanent UUID-v4 values in appendix C:

| File | Logic-function name | Trigger | Identifier constant |
|---|---|---|---|
| `src/logic-functions/wa-list-sendable-templates-tool.ts` | `whatsapp-list-sendable-templates` | `toolTriggerSettings` | `LF_LIST_SENDABLE_TEMPLATES_TOOL` |
| `src/logic-functions/wa-send-template-tool.ts` | `whatsapp-send-template` | `toolTriggerSettings` | `LF_SEND_TEMPLATE_TOOL` |

Do **not** put `toolTriggerSettings` directly on `wa-send-template-action`. That handler is a
workflow surface and deliberately records `sourceKind: WORKFLOW`, has no required idempotency key,
and accepts workflow-builder input shapes. Making it dual-surface would make MCP sends look like
workflow sends and would turn an MCP retry into a second customer message.

The wrappers are thin. Shared send mechanics move out of the workflow file into
`src/server/template-send.ts`; the workflow action and MCP tool both call that module with a
server-owned execution context:

```ts
type TemplateSendSource = {
  sourceKind: 'WORKFLOW' | 'AI_AGENT';
  sentById: string | null;
  requestId: string | null;
  channel: 'WORKFLOW_ACTION' | 'TWENTY_MCP';
};

executeTemplateSend(input, source): Promise<TemplateSendResult>;
```

`sourceKind`, `sentById` and `channel` are never part of either public input schema. The workflow
wrapper supplies `WORKFLOW`; the MCP wrapper supplies `AI_AGENT`. If probe P-MCP-2 proves that
Twenty provides an authenticated workspace-member id to a tool handler, the wrapper passes that id
as `sentById`. Otherwise it stays `null` and the audit detail records the authenticated surface as
`TWENTY_MCP`; it must never trust an `actorId`, `memberId`, `agentName` or similar caller field.

Add `AI_AGENT` to `SOURCE_KIND` and the `whatsappMessage.sourceKind` select. Existing values remain
unchanged. UI copy may render it as “AI agent” / “Agente de IA”.

---

## 4. Tool 1 — `whatsapp-list-sendable-templates`

### 4.1 Definition

```ts
export default defineLogicFunction({
  universalIdentifier: LF_LIST_SENDABLE_TEMPLATES_TOOL,
  name: 'whatsapp-list-sendable-templates',
  description:
    'Lists WhatsApp templates that are currently approved, published and safe to send to one Twenty CRM Person. Call this after uniquely resolving the Person and before whatsapp-send-template. This tool never sends a message.',
  timeoutSeconds: 15,
  toolTriggerSettings: { inputSchema: listSendableTemplatesInputSchema },
  handler,
});
```

The schema is declared explicitly; source inference is not used for an agent-facing contract.

### 4.2 Input schema

```ts
const listSendableTemplatesInputSchema: InputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    personId: {
      type: 'string',
      description: 'Exact Twenty Person record id. Resolve a unique Person with Twenty MCP first.',
    },
    accountId: {
      type: 'string',
      description:
        'Optional WhatsApp account record id. Omit only when exactly one connected account exists.',
    },
    language: {
      type: 'string',
      description: 'Optional exact Meta language code, for example pt_BR, pt_PT or en_US.',
    },
    category: {
      type: 'string',
      enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'],
      description: 'Optional business-purpose filter.',
    },
    nameContains: {
      type: 'string',
      description: 'Optional case-insensitive template-name fragment.',
    },
    first: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Page size; defaults to 20 and never exceeds 50.',
    },
    after: {
      type: 'string',
      description: 'Opaque cursor returned by the previous call.',
    },
  },
  required: ['personId'],
};
```

### 4.3 Resolution algorithm

1. Reject malformed/non-UUID `personId` as `PERSON_UNKNOWN`; UUID validation uses the existing
   `isUuid` helper.
2. Load the Person. Missing Person → `PERSON_UNKNOWN`.
3. Resolve the sending account exactly as the workflow action does: named connected account, or
   the only connected account. Zero → `ACCOUNT_UNKNOWN`; more than one with no `accountId` →
   `ACCOUNT_AMBIGUOUS`. Never choose the first account.
4. Resolve the Person's WhatsApp id using the account calling-code configuration. No usable phone
   → `NO_PHONE`. Do not create a thread.
5. Load an existing thread if present. For discovery only, an absent thread is represented as an
   unblocked thread with no service window; templates do not require an open window.
6. Query templates at the database boundary with all three mandatory predicates:

   ```text
   accountId = resolved account
   AND status = APPROVED
   AND publishedToCrm = true
   AND isUsableInCrm = true
   ```

   Apply optional language/category/name filters, stable order by `name`, then `language`, then
   `id`, and Relay pagination. Do not call `listTemplatesForAccount(..., 60)` and filter in memory;
   that would make eligible template 61 invisible.
7. For each candidate, call `evaluateSendPermission` with `kind: TEMPLATE`, `lane: INTERACTIVE`.
   Return only allowed candidates. Preserve warnings such as `consent_unknown_marketing` on the
   individual template.
8. Return no raw Meta components and no secrets. Derive a compact parameter contract and preview
   from `variableSpec`/the existing render helpers.

### 4.4 Result contract

```ts
type ListSendableTemplatesResult =
  | {
      status: 'ready';
      personId: string;
      account: { id: string; name: string | null; displayPhoneNumber: string | null };
      templates: Array<{
        id: string;
        name: string;
        language: string;
        category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
        preview: string;
        parameters: {
          body: Array<{ key: string; example: string | null; required: true }>;
          header:
            | null
            | { kind: 'text'; keys: string[]; examples: string[] }
            | { kind: 'media'; mediaType: 'IMAGE' | 'VIDEO' | 'DOCUMENT' };
          buttons: Array<{ index: number; kind: 'url'; required: true }>;
        };
        warnings: string[];
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    }
  | {
      status: 'denied';
      reason: 'PERSON_UNKNOWN' | 'ACCOUNT_UNKNOWN' | 'ACCOUNT_AMBIGUOUS' | 'NO_PHONE' | string;
      templates: [];
    };
```

An empty `templates` array with `status: ready` means no template matches the filters or current
policy. It is not permission to invent content. The agent should report that no published approved
template is available.

---

## 5. Tool 2 — `whatsapp-send-template`

### 5.1 Definition

```ts
export default defineLogicFunction({
  universalIdentifier: LF_SEND_TEMPLATE_TOOL,
  name: 'whatsapp-send-template',
  description:
    'Queues one published and Meta-approved WhatsApp template to one exact Twenty CRM Person. This changes external state and may contact a customer. Resolve the Person and call whatsapp-list-sendable-templates first. Never retry with a new requestId when the result is uncertain.',
  timeoutSeconds: 30,
  toolTriggerSettings: { inputSchema: sendTemplateInputSchema },
  handler,
});
```

### 5.2 Input schema

```ts
const sendTemplateInputSchema: InputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    personId: {
      type: 'string',
      description: 'Exact Twenty Person id selected through Twenty MCP; never a phone number.',
    },
    templateId: {
      type: 'string',
      description:
        'Exact template record id returned by whatsapp-list-sendable-templates. Names are not accepted.',
    },
    accountId: {
      type: 'string',
      description:
        'Optional account id. Omit only when exactly one connected WhatsApp account exists.',
    },
    parameters: {
      type: 'object',
      additionalProperties: true,
      description:
        'Template values matching the parameter contract returned by whatsapp-list-sendable-templates. Objects and arrays are allowed for header/body/button values.',
    },
    createThreadIfMissing: {
      type: 'boolean',
      description: 'Defaults to true. Set false only when the request requires an existing conversation.',
    },
    requestId: {
      type: 'string',
      description:
        'Required UUID v4 idempotency key for this intended send. Reuse it for every retry of the same intent; never reuse it for a different recipient, template or values.',
    },
  },
  required: ['personId', 'templateId', 'parameters', 'requestId'],
};
```

`templateId` is id-only on this surface. The workflow action keeps its name fallback for old
workflow bindings, but an agent already received exact ids from the discovery tool. Accepting names
would reintroduce the same-name/different-language ambiguity discovery removed.

There is no `confirm: true` input. A model can set a boolean itself, so it is not authorisation.
User confirmation or autonomous-send policy belongs to the MCP client/agent approval configuration;
the server enforces identity, role, consent, template state, idempotency and audit regardless.

### 5.3 Execution algorithm

1. Validate all ids and require `requestId` to be UUID v4. Invalid input returns `status: denied`
   with a named reason and produces no records.
2. Resolve Person, account, exact template, WhatsApp id and existing/new thread through the shared
   template-send module. Never resolve a template by name.
3. Bind and validate parameters with `bindWorkflowParameters` and `validateParameters`; returning
   `MISSING_VARIABLES` names every missing key. Sanitisation and length/newline rules remain in the
   existing template renderer.
4. Build the same `SendContext` and call `evaluateSendPermission` with the interactive template
   intent. The gate re-checks connected account, blocking, consent and all three template flags.
5. Before create, query by `clientToken = requestId`:
   - matching Person/thread, account, template and canonical resolved parameters → return the
     original message with `replayed: true`;
   - any mismatch → `IDEMPOTENCY_CONFLICT`, no new record;
   - no match → continue.
6. Queue with `lane: INTERACTIVE`, `sourceKind: AI_AGENT`, `sentById` only from an authenticated
   platform context, `clientToken: requestId`, and the normal template snapshot.
7. If the unique `clientToken` constraint loses a concurrent create race, re-read the winner,
   perform the same intent comparison and return replay/conflict. Never turn a uniqueness error
   into a second token or a second message.
8. Schedule through the existing interactive scheduler. The only component allowed to call Meta
   remains `wa-outbound-sender` (AR-11).
9. Emit `whatsapp.template.sent` audit/timeline data with `sourceKind: AI_AGENT`, `channel:
   TWENTY_MCP`, `requestId`, template id/name/language and Person/thread ids. Do not log parameter
   values or phone numbers.

The sender's existing just-in-time re-check remains mandatory. An opt-out or template rejection
that arrives after the tool queued the message but before the worker sends it suppresses the send.

### 5.4 Result contract

```ts
type SendTemplateToolResult =
  | {
      status: 'accepted';
      messageId: string;
      threadId: string;
      replayed: boolean;
      warnings: string[];
      delivery: 'queued';
    }
  | {
      status: 'denied';
      messageId: null;
      threadId: string | null;
      replayed: false;
      denialReason: ActionRefusal | 'INVALID_REQUEST_ID' | 'IDEMPOTENCY_CONFLICT';
      missingVariables?: string[];
      warnings: string[];
    };
```

Business denials are results, not thrown errors. Infrastructure failures throw so Twenty records a
failed tool execution and the caller may retry with the **same** `requestId`.

---

## 6. Shared-server refactor

Move the implementation currently inside `wa-send-template-action.runAction` into
`src/server/template-send.ts` without changing workflow behaviour. The shared module owns:

- `idOf`, account resolution and Person phone resolution;
- exact-id and workflow-compatible template resolution as two explicit strategies;
- thread find/upsert;
- workflow/MCP parameter binding and validation;
- send-context construction and policy evaluation;
- idempotent replay/conflict comparison when `requestId` is present;
- queueing, scheduling and audit emission.

The wrappers own only public-schema parsing and server-owned source context. The workflow wrapper
must remain contract-compatible with 09 §1 and keep `sourceKind: WORKFLOW`, `requestId: null` and
its record-or-id/name compatibility. The MCP wrapper uses exact ids, object parameters,
`sourceKind: AI_AGENT` and a mandatory request id.

No policy predicate may be copied into either wrapper. The rule “approved + published + usable”
must still have one authoritative enforcement point in `evaluateSendPermission`; the discovery
query is an optimisation and UX filter, not a second gate.

---

## 7. Repository changes

### 7.1 Templates

Add a cursor-aware finder to `src/server/repositories/templates.ts`:

```ts
listSendableTemplatesPage({
  accountId,
  language,
  category,
  nameContains,
  first,
  after,
}): Promise<{ templates: WhatsappTemplateRecord[]; pageInfo: PageInfo }>;
```

It applies the three sendable predicates in the Core API query, not in memory, clamps `first` to
1–50 and selects only fields needed to derive the public result. `after` is opaque and is never
decoded by app code.

### 7.2 Messages

Reuse `findMessageByClientToken`. Add a comparison helper in the shared template-send module; do
not hide semantic comparison inside the repository. The repository answers what exists, while the
service decides whether it represents the same send intent.

The existing `clientToken` unique field is sufficient; no new object or index is required. Update
its description from browser-only wording to “caller-generated idempotency key” because UI and MCP
now share it.

### 7.3 Source kind and copy

Add `AI_AGENT` to:

- `src/domain/constants.ts`;
- `whatsappMessage.sourceKind` options;
- any TypeScript unions/golden expectations;
- Portuguese/English transcript and diagnostics copy.

Do not rename the existing `AGENT` value: it continues to mean a human CRM agent and changing it
would rewrite history.

---

## 8. Permissions and safety boundary

The MCP connection must authenticate to Twenty with a role that is intentionally authorised to
read the relevant People and WhatsApp templates. `WhatsApp Agent` is the minimum product role;
`WhatsApp Admin` is not required to send and does not bypass the gate.

The following controls are mandatory:

| Threat | Control |
|---|---|
| Agent guesses a phone number | Send tool has no phone input; Person id is resolved server-side. |
| Agent guesses an unpublished template id | Exact template is loaded and the policy gate rejects it. |
| Agent edits `whatsappMessage` directly | Agent role retains read-only message permission. |
| Agent asks to override opt-out/blocking | No override field exists; gate is unconditionally re-run. |
| MCP/network retries after an uncertain response | Required UUID-v4 `requestId`, unique `clientToken`, replay comparison. |
| Agent reuses a request id for a different send | `IDEMPOTENCY_CONFLICT`; no new record. |
| Caller forges attribution | Identity is platform-derived or null; no actor input exists. |
| Tool output leaks template internals | Discovery returns a compact parameter contract, not raw Meta components. |
| Compromised broad API key invokes tools | Release probe P-MCP-1; production MCP credential is role-scoped and separately revocable. |

Twenty app logic functions use the app role's injected token for Core API access. Therefore the
tool must not claim stronger row-level isolation than Twenty actually provides. In the current app,
the WhatsApp Agent role has Person read access and P-7 already tracks row-level predicates. If
row-level Person visibility is enabled later, MCP sending is not considered compatible until an
integration test proves the tool cannot send to a Person invisible to the invoking MCP principal.

---

## 9. Agent operating instructions

Tool descriptions are part of the safety design, but are not substitutes for server checks. The
recommended Twenty agent/skill instructions are:

1. Search People with Twenty MCP and resolve exactly one record. If several records plausibly
   match, ask the user which one; do not choose by list order.
2. Do not use an email address or phone number as the send recipient. Pass the resolved Person id.
3. Call `whatsapp-list-sendable-templates` and choose only from its result.
4. Match language and purpose. Never translate, rewrite or invent a template body.
5. Fill every required parameter from CRM context or explicit user input. Do not guess sensitive,
   financial, authentication or appointment values.
6. Before the side-effecting call, follow the MCP client's configured approval policy. An
   autonomous agent may send only when its assigned role and operating policy permit it.
7. Generate one UUID-v4 `requestId` per intended message and keep it unchanged across retries.
8. Report “queued” after `accepted`; do not claim delivery until the CRM message status says so.
9. On `denied`, explain the reason and stop. Do not look for a lower-level path around the gate.

The optional app-defined Twenty skill/agent that contains these instructions is a separate product
surface. It is not required for external MCP clients to discover the two tools, and it must not be
used as the only enforcement mechanism.

---

## 10. Observability and audit

Add structured events without message body, parameters, phone, token or secrets:

| Event | Fields |
|---|---|
| `wa.mcp.templates.listed` | correlation id, Person id, account id, filters, count, hasNextPage |
| `wa.mcp.template.denied` | correlation id, Person id, account id?, template id?, denial reason |
| `wa.mcp.template.queued` | correlation id/request id, Person id, thread id, message id, template id, replayed |
| `wa.mcp.idempotency_conflict` | request id, existing message id, requested Person/template ids |
| `wa.mcp.tool_failed` | tool name, correlation id, redacted `describeError` output |

`requestId` is a correlation/idempotency identifier, not a secret, but it is never used as a log
message. It is a structured field. Existing log redaction applies.

Metrics:

- `wa_mcp_template_discovery_total{outcome}`;
- `wa_mcp_template_send_total{outcome,reason}`;
- `wa_mcp_template_send_replay_total`;
- `wa_mcp_template_send_latency_ms` through queue acceptance.

No new health-panel state is required. Queued/stuck/failure monitoring is shared with all outbound
messages and already covers this source.

---

## 11. Test plan

### 11.1 Unit

- Input schemas are explicit, `additionalProperties: false` at the top level, and require the
  documented fields.
- UUID-v4 validation rejects v1/v5/malformed request ids.
- Discovery predicate always contains account, `APPROVED`, published and usable filters.
- Discovery does not create a thread.
- Parameter-contract derivation covers positional/named body values, text/media headers and URL
  buttons.
- Exact-id MCP template resolution never falls back to a name.
- Same request id + same canonical intent → replay; same id + changed Person/account/template/value
  → conflict.
- `AI_AGENT` serialises through the object select and transcript copy.

### 11.2 Integration

- MCP manifest/tool catalogue contains both stable tool names and their schemas.
- Person with one account and two eligible languages returns both; language filter returns one.
- Template row 61 is reachable through pagination.
- Pending, rejected, paused, unpublished and unusable templates are absent from discovery and are
  still refused when their ids are passed directly to the send tool.
- Person with no phone, ambiguous accounts, opted-out consent, blocked thread and missing variables
  each return the named denial and create no outbound message/provider call.
- Unknown-consent marketing template returns the existing warning; utility template remains
  allowed under the existing policy.
- Allowed send creates one queued interactive message with `sourceKind: AI_AGENT`, exact template
  snapshot, request id and audit event.
- Two concurrent identical calls produce one message; both callers receive the same message id,
  one with `replayed: true`.
- Retry after the first call queued but before it responded returns the original record.
- Opt-out/template rejection between queue and sender prevents the Meta call.
- Workflow-action regression: its input compatibility, denial result and `sourceKind: WORKFLOW`
  remain unchanged after the shared-service extraction.

### 11.3 End to end

Using a restricted Twenty MCP credential and a Meta test number:

1. Ask the agent to find a known test Person; verify Twenty MCP returns only the intended record.
2. Ask which Portuguese published templates can be sent; verify no unpublished template appears.
3. Ask it to send one utility template with explicit values; record the `requestId` and message id.
4. Repeat the identical MCP tool call with the same request id; verify one handset message and
   `replayed: true`.
5. Repeat with one changed parameter and the same id; verify `IDEMPOTENCY_CONFLICT` and no handset
   message.
6. Opt the Person out and attempt again with a new id; verify denial and no provider call.
7. Restore test consent, send again, and observe queued → sent → delivered/read through webhooks.
8. Verify transcript source is AI agent and the audit event contains no message values or phone.

---

## 12. Release probes and rollout

### P-MCP-1 — tool authorisation (release blocking)

Test against the pinned Twenty version and the hosted MCP endpoint:

1. An anonymous/invalid MCP credential cannot list or invoke either app tool.
2. A valid credential assigned a role without WhatsApp capability cannot invoke the send tool.
3. A WhatsApp Agent credential can discover and invoke it.
4. A restricted credential cannot use generic record-create tools to create a sendable
   `whatsappMessage` or mutate `publishedToCrm`.

If item 2 fails, **do not ship the send tool**. `toolTriggerSettings` has no handler-level caller
header in SDK 2.31.0, so there is no honest in-app fallback that reconstructs authentication from a
caller-supplied id. Keep discovery disabled as well unless its data exposure is acceptable to every
workspace member.

### P-MCP-2 — authenticated attribution (not release blocking)

Inspect the real tool invocation payload/runtime for a platform-authenticated workspace-member or
agent id. If present and bound by Twenty, store the workspace member in `sentById` and audit actor.
If absent, keep both null and show `sourceKind: AI_AGENT` plus `channel: TWENTY_MCP`. Never make up
an actor or accept one in the input.

### Rollout

1. Land shared-service extraction with both wrappers still unexposed; run the full workflow/UI
   regression suite.
2. Land discovery tool and validate catalogue/schema/pagination against a non-production workspace.
3. Pass P-MCP-1/P-MCP-2 on the pinned Twenty version.
4. Enable send tool only for a dedicated, role-scoped test MCP credential and Meta test number.
5. Run §11.3, including replay/conflict and opt-out.
6. Roll out to one workspace with audit review after 24 hours.
7. Document credential revocation and disablement before broader release.

Rollback is manifest-level: remove `toolTriggerSettings` from the two wrappers and redeploy. Do not
delete logic-function identifiers or message history. Queued messages already accepted continue
through the normal sender unless a send-time policy state changes first—for example the thread is
blocked, the Person opts out, or the template is unpublished/rejected.

---

## 13. Implementation task breakdown

| # | Task | Depends on | Done when |
|---|---|---|---|
| 11.1 | Scaffold two logic functions and register UUID-v4 constants | — | manifest builds with stable ids |
| 11.2 | Add `AI_AGENT` source kind and bilingual copy | — | object/type/copy tests pass |
| 11.3 | Extract `src/server/template-send.ts` | 11.2 | workflow action tests pass unchanged |
| 11.4 | Add paginated sendable-template repository query | — | filter/page tests pass incl. row 61 |
| 11.5 | Implement parameter-contract projection | 11.4 | positional/named/media/button fixtures pass |
| 11.6 | Implement discovery tool and explicit schema | 11.4–5 | read-only integration tests pass |
| 11.7 | Implement request-id replay/conflict semantics | 11.3 | sequential/concurrent tests pass |
| 11.8 | Implement send tool and explicit schema | 11.3, 11.7 | policy/queue/audit tests pass |
| 11.9 | Add manifest architecture guards | 11.6, 11.8 | tool names/schemas/source imports pinned |
| 11.10 | Run P-MCP-1 and P-MCP-2 | 11.9 | authorisation gate recorded |
| 11.11 | Run restricted-credential Meta E2E | 11.10 | §11.3 evidence captured |
| 11.12 | Update setup/runbook/release checklist | 11.10 | role, approval, revocation and rollback documented |

---

## 14. Acceptance criteria

The feature is complete only when all are true:

- Both tools appear through Twenty MCP with the exact names and explicit schemas in this spec.
- The agent can find a Person using ordinary Twenty MCP record tools without app-specific contact
  search code.
- Discovery returns no template outside the approved + published + usable intersection.
- A direct call with an ineligible template id is still denied server-side.
- The send tool accepts no raw recipient and no free-form body.
- A successful call produces one queued interactive message sourced as `AI_AGENT` and no direct
  Meta call outside `wa-outbound-sender`.
- Same-intent retries are idempotent under concurrency; changed-intent token reuse conflicts.
- Consent, blocking, account state, parameter and just-in-time sender re-checks all remain active.
- Workflow sending remains backward-compatible and continues to record `WORKFLOW`.
- P-MCP-1 passes on the pinned Twenty version.
- Audit/log output identifies the MCP surface without exposing message values, parameters or phone.
- The real-handset loop proves one send, one replay, one conflict, one opt-out denial and delivery
  status reconciliation.

## References

- Twenty logic functions — `toolTriggerSettings` and workflow actions:
  <https://docs.twenty.com/developers/extend/apps/logic/logic-functions>
- Twenty APIs — workspace-schema-generated record tools:
  <https://docs.twenty.com/developers/extend/api>
- Existing workflow action: [09 §1](09-workflows-timeline-notifications.md#1-workflow-action-send-whatsapp-template--fr-wf-1-must)
- Outbound invariants and policy: [04](04-outbound-pipeline.md)
- Template publishing and consent: [06](06-templates-and-consent.md)
- Roles and audit: [10](10-security-roles.md)
