# Appendix B — Meta error catalog

Implements TRD §11.2, FR-OUT-4. This table is **data**, not prose: it is implemented as
`src/providers/whatsapp/errors.ts` (classification, server-side) plus
`src/components/common/copy.ts` (pt/en user copy, front-end — 01 §7).

Classification values, defined in [04 §7](04-outbound-pipeline.md#7-retry-and-error-classification):
`retryable_backoff` · `retryable_after_refresh` · `terminal_recipient` · `terminal_content` ·
`terminal_unknown`.

---

## 1. Send errors

| Code | Meaning | Class | System behaviour | User copy (pt) |
|---|---|---|---|---|
| **131047** | Re-engagement required — outside the 24 h window | `terminal_recipient` | Should be pre-empted by the policy gate; if it occurs, mark failed, open the template picker, and **raise an alert** — it means the gate has a bug | "A janela de 24 horas fechou. Envie um modelo aprovado." |
| **131026** | Recipient not on WhatsApp / undeliverable | `terminal_recipient` | Mark failed; suggest verifying the number on the Person; in a campaign, count as failed (not skipped) | "Este número não está no WhatsApp." |
| **131049** | Meta per-user marketing frequency cap | `terminal_recipient` | 1:1 → failed with explanation. **Campaign → recipient `skipped`, counted separately, never retried** (FR-CAM-9) | "A Meta limitou mensagens de marketing para este contacto hoje." |
| **131051** | Unsupported message type | `terminal_content` | Mark failed; log the payload — indicates a builder bug | "Tipo de mensagem não suportado." |
| **131053** | Media upload/download error | `retryable_backoff` | Retry the upload; if a link-send was somehow attempted, force the `media_id` path (AR-14) | "Falha ao enviar o ficheiro. A tentar novamente." |
| **131056** | (Business, user) pair rate limit | `retryable_backoff` | Backoff **and** increase this recipient's spacing for the rest of the run | "A enviar demasiado depressa para este contacto. A aguardar." |
| **130429** | Throughput/rate limit exceeded | `retryable_backoff` | Backoff with jitter; alert if sustained over 5 minutes | (internal — retried silently) |
| **131000** | Generic Meta internal error | `retryable_backoff` | Backoff, max 5 | "Erro temporário do WhatsApp. A tentar novamente." |
| **131008** | Required parameter missing | `terminal_content` | Fail; in a campaign, **pause** — the mapping is wrong for everyone | "Faltam parâmetros no modelo." |
| **131009** | Parameter value invalid | `terminal_content` | Fail; campaign pauses | "Valor de parâmetro inválido." |
| **132000** | Template param count mismatch | `terminal_content` | Fail; campaign pauses; trigger a template re-sync (the local spec is stale) | "O modelo mudou. Sincronize os modelos." |
| **132001** | Template does not exist / not approved in this language | `terminal_content` | Fail; mark the template `disabled`, un-publish, re-sync | "Modelo indisponível." |
| **132005** | Template hydrated text too long | `terminal_content` | Fail; campaign pauses | "O texto gerado excede o limite do modelo." |
| **132007** | Template format character policy violation | `terminal_content` | Fail — the parameter contained newlines/tabs/4+ spaces that validation missed; log as a validation gap | "Formato de parâmetro inválido." |
| **132012** | Template parameter format mismatch | `terminal_content` | Fail; campaign pauses | "Formato de parâmetro não corresponde ao modelo." |
| **131064** | Messaging limit / template category misuse | `terminal_content` | Alert admin, **freeze that template's `publishedToCrm`**, pause campaigns using it | "Utilização do modelo bloqueada pela Meta." |
| **131031** | Account locked / policy violation | `terminal_unknown` | Account → `error`, all sends paused, admin alert with the Business Support Home link | "Conta bloqueada pela Meta. Contacte o suporte." |
| **368** | Temporarily blocked for policy violations | `terminal_unknown` | Same as 131031 | "Conta temporariamente bloqueada." |
| **100** | Invalid parameter / bad request | `terminal_content` | Fail; log the full request (redacted) — almost always our bug | "Pedido inválido." |
| **190** | Access token expired/invalid | `retryable_after_refresh` | Account → `error`; **do not retry**; admin alert; sends pause until the token is rotated (R-8) | "Token da Meta expirou. Actualize nas definições." |
| **200 / 10 / 299** | Permission error (missing scope) | `retryable_after_refresh` | Account → `error`; alert naming the required scopes | "Permissões insuficientes no token da Meta." |
| **80007** | Rate limit on the Graph API itself | `retryable_backoff` | Backoff | (internal) |
| **33** | Object does not exist / no permission | `terminal_unknown` | Usually a wrong `phone_number_id`; account → `error` with a specific hint | "Número não encontrado. Verifique o phone_number_id." |
| *(unmapped)* | — | `terminal_unknown` | Fail, log the complete Meta body, increment `wa.send.unmapped_error` | "Erro não identificado ({code})." |

`wa.send.unmapped_error` being non-zero is the signal that this table needs a new row — it is
listed in the triage order (11 §6) for exactly that reason.

---

## 2. HTTP-level handling

| Status | Class | Behaviour |
|---|---|---|
| 400 | per the body's `error.code` | as above |
| 401 / 403 | `retryable_after_refresh` | account → `error`, no retry |
| 404 | `terminal_unknown` | wrong id; account → `error` with a hint |
| 429 | `retryable_backoff` | honour `Retry-After` when present, else backoff |
| 5xx | `retryable_backoff` | backoff, max 5 |
| network error **before** the request completed | `retryable_backoff` | safe to retry |
| timeout **after** the request was fully written | **`terminal_unknown`** | mark `UNKNOWN_ACCEPTANCE`; **never retry** — Meta may have accepted it, and a duplicate customer message is worse than a false failure (04 §5) |

---

## 3. Internal (non-Meta) error codes

Stored in `whatsappMessage.errorCode` alongside Meta codes; distinguishable by being
non-numeric.

| Code | Meaning | Where set |
|---|---|---|
| `POLICY_WINDOW_CLOSED` | Window closed between queue and send | sender re-check (04 §5 step 4) |
| `POLICY_OPTED_OUT` | Contact opted out after queueing | sender re-check |
| `POLICY_TEMPLATE_UNAVAILABLE` | Template un-published or rejected after queueing | sender re-check |
| `POLICY_ACCOUNT_ERROR` | Account not connected at send time | sender re-check |
| `INTERNAL_TIMEOUT` | Stuck in `queued` > 15 min | `wa-health-check` (NFR-R3) |
| `UNKNOWN_ACCEPTANCE` | Ambiguous send outcome | sender (§2) |
| `CANCELLED` | Campaign cancelled before sending | `wa-campaign-control` |
| `MEDIA_TOO_LARGE` | Exceeds Meta's limit | pre-send validation (AR-16) |
| `MEDIA_UNAVAILABLE` | Stored file missing at send time | sender |
| `CONFIG_MISSING` | A required server variable is unset | `requireSecret` |

---

## 4. Webhook-side errors

`value.errors[]` and `statuses[].errors[]` are stored on the message (`errorCode`/`errorDetail`)
and on the raw event. Inbound `errors[]` — typically an undecryptable media — produce a message
of `type: 'unsupported'` carrying the error rather than a dropped message (03 §4.1).

---

## 5. Copy rules

- User-facing copy is **pt-PT first**, en second (A-6), and lives only in the front end.
- Every message names the situation and the next action. "Erro 131047" alone is not acceptable
  copy; "A janela de 24 horas fechou. Envie um modelo aprovado." is.
- The raw code is always available behind a "Detalhes" disclosure, because support conversations
  with Meta need it.
- Copy never blames the user and never speculates ("talvez", "possivelmente"). If the system does
  not know, it says so and shows the code.
