# Domain F browser QA run - 2026-08-18

## Environment

- App: WhatsApp, version 0.1.0, Twenty SDK/CLI 2.31.0.
- Target: `http://localhost:2020` via Codex in-app browser.
- Persona: authenticated workspace user shown as `Apple`; Agent/member/signed-out personas were not available.
- Browser: Codex in-app browser only. Chrome/Safari/Firefox sessions were not available.
- Relaunch: `yarn twenty dev`; manifest initialized, but resource/entity build continued during the run (`100 synced`, `1 building` observed).
- Evidence: live DOM snapshots, browser console logs, route reloads, and keyboard Tab smoke.

## S1/S2 blocks

- S1-BUILD-SYNC: the dev runner remained in build/sync, and the WhatsApp Campaigns page and application detail Permissions page rendered only the host shell/blank content after reload. This prevented all campaign/settings assertions and several resilience checks.
- S2-UX-LOCALE: the live Inbox showed mixed locale copy (`Pesquisar`, `Nova conversa`, `Espaço de trabalho` alongside `Inbox`, `Campaigns`, and English WhatsApp copy). This blocks locale-coherence acceptance for UX-06/UX-07.
- S2-CONSOLE-I18N: repeated console warnings reported uncompiled catalog messages for `Create new Company` and `New Company`. No secret value was observed in the console or visible DOM snapshot.

## Summary

- Pass: 0
- Partial: 2 (`ROLE-05`, `UX-01`)
- Fail: 2 (`UX-06`, `UX-07`)
- Blocked: 23
- S1 blocks: 1
- S2 blocks: 2

## Per-case status

| Case | Status | Evidence / reason |
|---|---|---|
| ROLE-01 | Blocked | Inbox route opened and showed Mine/Unassigned/All filters, but no Agent persona or selected thread was available; no outbound/write action was performed. |
| ROLE-02 | Blocked | Campaigns route loaded the host shell but its content stayed blank; Agent persona and direct 403 check unavailable. S1-BUILD-SYNC. |
| ROLE-03 | Blocked | Application detail Permissions route loaded the host shell but its content stayed blank; Agent persona and mutating-control checks unavailable. S1-BUILD-SYNC. |
| ROLE-04 | Blocked | No ordinary-member or signed-out browser session was available; logout was not used because it would destroy the only authenticated test session. |
| ROLE-05 | Partial | Console and visible DOM snapshots contained no Meta secret, access token, or verify token. Network inspection and storage inspection were not available through the live browser surface. Repeated uncompiled-catalog warnings observed. |
| ROLE-06 | Blocked | No second agent identity/thread fixture was available for restricted-visibility deep-link/search validation. |
| ROLE-07 | Blocked | No safe message/template/campaign fixture was available; sending or mutating content would create representational side effects and was not attempted. |
| ROLE-08 | Blocked | No destructive/write control was reachable because Campaigns content was blank and no thread was selected. |
| RES-01 | Blocked | Browser network offline control was not exposed; no offline/automatic-recovery assertion executed. |
| RES-02 | Blocked | One-shot 401/token-refresh injection was not exposed. |
| RES-03 | Blocked | 403/409/429/500/timeout/malformed-response injection was not exposed. |
| RES-04 | Blocked | Background-tab interval and system clock/timezone manipulation were not available in the live session. |
| RES-05 | Blocked | A second concurrent agent/session was not available. |
| RES-06 | Blocked | Campaign build and diagnostic replay surfaces were blank; optimistic-send fixture was unavailable. |
| RES-07 | Blocked | A 30-minute soak was not run in this session. |
| UX-01 | Partial | Inbox was navigable with keyboard Tab and the visible DOM exposed named controls including tabs, New chat, search, filters, and navigation links. Full critical journeys, focus visibility, keyboard trap, and J/K/A checks were unavailable without a selectable thread/composer. |
| UX-02 | Partial | Accessibility snapshot exposed names for the main tabs, search, filters, navigation links, and buttons. Error association, toggle state, composer labels, and campaign progress states were unavailable. |
| UX-03 | Blocked | No screen-reader integration was available and no selected thread/composer/campaign progress surface was reachable. |
| UX-04 | Blocked | 200% zoom/narrow-container viewport control was not available through the current browser session. |
| UX-05 | Blocked | Theme-switch control was not reachable on the tested surfaces. |
| UX-06 | Fail | Live UI mixed Portuguese host copy with English WhatsApp surface copy; full P0/P1 locale sweep could not complete. S2-UX-LOCALE. |
| UX-07 | Fail | Mixed Twenty host and app screens were not locale-coherent: Portuguese settings/navigation labels coexisted with English `Inbox`, `Campaigns`, and app copy. S2-UX-LOCALE. |
| UX-08 | Blocked | Long-name/number/template/error fixtures were not available and no mutation was attempted. |
| UX-09 | Blocked | Reduced-motion/high-contrast preference controls were not available in the in-app browser surface. |
| UX-10 | Blocked | Only the in-app browser was connected; Chrome/Safari/Firefox media, clipboard, scroll, and side-panel matrix was not executable. |

## Console/network and data notes

- Browser console: no `error` entries observed on the final Campaigns reload; repeated warning entries reported uncompiled catalog messages for `Create new Company` and `New Company`.
- Network: route navigation/reload worked against localhost; detailed request interception/status injection was not exposed by the active in-app browser API.
- Secret scan: no Meta app secret, access token, or verify token appeared in the inspected visible DOM or console output. This is not a storage/network guarantee.
- Recipients/spend: none; no messages or campaigns were sent or created.
- QA data changes: none intentionally created, changed, archived, or deleted.

## Sign-off

- QA: pending due S1-BUILD-SYNC and unavailable personas/fault-injection controls.
- Engineering: pending.
- Sending-number owner: not applicable; no send occurred.
