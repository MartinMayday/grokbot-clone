# Hardening Ledger — v0.1.0-glm-e2b → v0.2.0-glm-e2b

Format: `[P0|P1|P2] file:line — finding — minimal fix`

Phases: P1 silent-failure-hunt (swallowed errors + silent fallbacks, degradation
notices) → P2 typescript review (server diff upstream/main..hardening/v0.2) →
P3 react review (web) → P4 leader implement (smallest-diff-first) → P5 re-review
fix diffs → P6 e2e journeys on 9130 → P7 ship (tag v0.2.0-glm-e2b).

Fixed constraints (do not relitigate):
- History/DB stays upstream Responses-shaped; conversion only at the model-call seam (chatbridge).
- Model routing: plain name = default env provider; `prv_x/name` = custom provider; per-bot override beats global default.
- Voice / web-search / Composio are by-design degradations — surface with user-visible notices, never rebuild.

## P1 — silent-failure-hunter (swallowed errors, silent fallbacks, missing notices)

Seat stalled on first dispatch ("could not complete"); leader ran the checklist
2026-11-16. Findings:

- [P1] server/src/providers.ts:110 — bot.model `prv_x/name` whose provider was deleted silently falls back to the env default model; picker keeps showing the stale label; user never told — resolveModel should signal the fallback; callModel should append a one-time notice row ("Model provider deleted; using default").
- [P1] server/src/agent/chatbridge.ts:23 + loop.ts:133-138 — web_search/x_search dropped in chat mode with no notice anywhere; system prompt doesn't mention it; model may claim it can search — in chatMode append a capability note to the system message at the model-call seam ("web search and X search are not available on this provider").
- [P1] server/src/routes.ts:340-351 + web ConnectAppsModal.tsx:79,145-151 — Composio unconfigured → /apps returns empty catalog; the modal renders an empty dialog with no reason — /apps should return a `configured` flag; modal shows "App connections are not configured on this deployment".
- [P1] server/src/agent/tools.ts:454-462 — request_app_connection with Composio unconfigured returns misleading "Unknown toolkit" to the model — early-return "connected apps are not configured on this deployment".
- [P1] server/src/voice.ts:238-255, 413-436, 438-456 — voice is xAI-only; on the GLM deployment /session /preview /stt always fail with generic messages ("Could not start a voice session") because the ZAI key hits api.x.ai → 401; user never learns voice is a permanent degradation — return an explicit reason ("voice needs an xAI key; this provider has no realtime voice"); VoiceCallBar v.error and Composer dictation error already display server error text.
- [P1] server/src/agent/loop.ts:281-290 — 400-retry path silently drops Composio tools (console.warn only); if Composio is configured the user never learns connected-app tools vanished — append a notice row when the retry fires.
- [P2] server/src/voice.ts:396-398 — call summarizeCall uses the xAI Responses API; on GLM it always fails silently → voice-call records never get summaries — route through the chat bridge (chatOnceText).
- [P2] web/src/App.tsx:35, BotSettingsModal.tsx:44,208, AppSettings.tsx:196,278,295 — silent `.catch(() => {})` on UI data loads; failed loads look like empty views.
- [P2] server/src/orgo.ts:196 — browser missing after sandbox bootstrap → console.warn only; browser tools degrade silently.
- [P2] server/src/routes.ts:322-336 — bot screenshot failure → silent 204.

Verified PRESENT (no fix needed):
- computer-creation failure: computerState.error surfaces in ComputerViewer.tsx:100 and AppSettings.tsx:229; tool-path failures surface as error rows (loop.ts:219-221).
- provider offline: ModelsSection shows `unreachable: <error>` (AppSettings.tsx:127); composer picker marks providers `· offline` (Composer.tsx:33).
- model-auth 401 (ZAI placeholder): callModel throws → notice row "Something went wrong: …" (loop.ts:161-163), rendered in Transcript.tsx:121.
- E2B unconfigured: requireE2B throws OrgoError → computers.status=error + hub emit → UI shows.
- Housekeeping catches (proactive tick, routine scheduling, idle suspend, memory compaction fallback chain) are logged and non-user-facing: acceptable.

## P2 — typescript-reviewer (server)

Seat unaddressable (roster memberRef malformed in leader context) and Agent-tool
dispatch failed (agent model unavailable); leader ran the checklist 2026-11-16
over `git diff upstream/main...HEAD -- server/`. ZERO P0 findings.

- [P1] server/src/orgo.ts:270-281 — createScreen derives the new screen index from `extras.length + 1`; after deleting a middle screen (e.g. screen-1 while screen-2/3 exist) the next create reuses screen-3 / display :3 / ports 5903+6083, colliding with the existing screen-3 → two bots silently share one desktop — derive n from max existing numeric suffix.
- [P2] server/src/agent/chatbridge.ts:108-152 — finish_reason ignored; a `length`-truncated response is emitted as response.completed with no signal (silent mid-sentence truncation) — capture finish_reason and mark/suffix truncation.
- [P2] server/src/agent/chatbridge.ts:126-131 — tool_call deltas without `index` all merge into one accumulated call (Map key undefined) — default `tc.index ?? 0` (GLM sends index; defensive).
- [P2] server/src/routes.ts:52-61 — DEV_LOGIN auto-sign-in on GET /auth/me: concurrent first loads race findOrCreateUser → UNIQUE(email) violation → 500 — INSERT OR IGNORE + re-select.
- [P2] server/src/orgo.ts:184-208 — crash between Sandbox.create and saveState leaks a sandbox until the 1h self-host cap reaps it — accepted by design (lifetime cap); noted.

Verified OK (explicitly): resolveModel `prv_x/name` parsing with '/' in model names (rest.join('/')); usage passthrough prompt/completion → input/output tokens; empty-text + tool-only responses; content null vs '' in toChatMessages; OrgoError 404/409 semantics vs computer.ts expectations; createProvider baseUrl validation + trailing-slash strip; providersView never returns api keys; inflight/queues/calls maps cleaned in finally-blocks / sweepers; enqueue vs aborts race guarded per-step.

## P3 — react-reviewer (web)

Seat failed on first dispatch (same stall as P1); leader ran the checklist
2026-11-16. ZERO P0 findings.

- [P1] web/src/components/config/AppSettings.tsx:188 — screenLabel subtracts 98 (upstream Orgo screen numbering); E2B screens are screen-1..3 so the UI renders "Screen -97" — drop the `- 98`.
- [P2] web/src/components/Composer.tsx:26,145 — a failed /models fetch leaves the picker menu stuck on "Loading models…" with no error state — show "Models unavailable" on fetch failure.
- [P2] web/src/components/config/AppSettings.tsx:135 — one-off inline style `var(--color-danger, #e5484d)` — reuse the existing `.cfg-error` class (token consistency).
- [P2] web/src/components/config/AppSettings.tsx:139-144 — inline flex styles on the provider form inputs — move to a config.css class.
- [P2] web/src/components/Menu.tsx — menus have Escape/outside-click but no arrow-key item navigation or focus trap (upstream pattern, app-wide; polish only).

Verified OK (explicitly): no login flash (App renders a blank boot div until authChecked; SignIn only when user is null after the check); model chip has aria-haspopup/aria-expanded + explanatory title; dictation button has aria-label/aria-pressed and state-aware title; apiKey input is type=password and keys are never echoed by the API; provider CRUD shows validation + server errors and uses ConfirmButton for delete; notice rows render tone classes (Transcript.tsx:121); VoiceCallBar displays v.error (will show the new explicit voice-unavailable reason once the server sends it); ConnectAppsModal has a load-error state; composer/model CSS classes exist in chat.css (token-consistent).

## Fixes applied (leader)

All P1 findings fixed + cheap P2s, 2026-11-16 (typecheck + build green after each cluster):

- providers.ts — resolveModel returns `fallbackNotice` when a `prv_x/` provider is missing (no more silent reroute).
- agent/loop.ts — one-per-generation notice row on provider-deleted fallback; chat-mode system note at the model-call seam (web/X search unavailable on this provider, model instructed to say so); notice row when the 400-retry path drops connected-app tools (both chat and responses branches).
- routes.ts — /apps response carries `configured: !!env.composioKey`; /apps/:slug/connect failures return 503 with the reason; findOrCreateUser survives the DEV_LOGIN first-load race on UNIQUE(email).
- agent/tools.ts — request_app_connection early-returns an explicit "app connections not configured" answer to the model when COMPOSIO_API_KEY is unset.
- voice.ts — /session /preview /stt return 503 with an explicit voice-unavailable reason when the default provider is not xAI (env.xaiChatMode); summarizeCall now runs on the configured default provider (chat bridge in chat mode) instead of hardcoded api.x.ai.
- orgo.ts — createScreen numbers above the highest existing screen index (deleted middle screens can no longer cause display/port collisions).
- agent/chatbridge.ts — tool_call deltas default `index ?? 0`; `finish_reason: length` streams a visible truncation marker (delta + final output).
- web AppSettings.tsx — screenLabel no longer subtracts 98 ("Screen -97" → "Screen 1"); provider form errors use `.cfg-error` class; provider form inputs use cfg-input--* classes.
- web/styles/config.css — added .cfg-row--wrap / .cfg-input--name / .cfg-input--url.
- web Composer.tsx — model picker shows "Models unavailable — try again later" after a failed /models fetch.
- web ConnectAppsModal.tsx + lib/api.ts — explicit empty state when the server reports Composio unconfigured.

Accepted-unchanged P2s: UI data-load `.catch(() => {})` (upstream pattern, non-critical loads); orgo browser-missing console.warn (bootstrap failure itself throws); bot screenshot silent 204; Menu arrow-key navigation.

## Re-review verdicts

Reviewer seats stalled/unaddressable (silent-failure-hunter: could-not-complete; typescript-reviewer: malformed memberRef + Agent-tool model unavailable; react-reviewer: could-not-complete). Leader re-reviewed the full staged fix diff against both checklists:

- chatbridge marker must stream as a delta to reach the live message row (caught and fixed in re-review; row text is built from deltas, not final.output).
- voice guards precede any x.ai fetch; XAI constant remains only for genuinely xAI-only endpoints behind guards.
- orgo screen numbering verified for {default, screen-2, screen-3} → screen-4; limit semantics unchanged.
- findOrCreateUser loser path returns the winner's user (winner created the primary bot).
- No new one-off styles; all new web states reuse existing tokens/classes.
Verdict: ZERO P0/P1 remaining in the fix diff.

## Re-review verdicts

(pending)

## E2E journeys (9130)

(pending)

## Ship

(pending)
