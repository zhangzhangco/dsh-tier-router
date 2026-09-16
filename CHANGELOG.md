# Changelog

## [0.2.1] - 2026-09-16

Four defects found by reading the code, all with regression tests (99 → 111).

### Fixed

- **The context guard could not see tool output, so it under-estimated exactly the sessions it
  exists to protect.** `estimatePromptTokens` read only top-level text/image blocks and charged a
  flat 64 tokens for anything else — including `tool-result`, whose payload lives in a NESTED
  content array. A 14,000-character tool result was counted as 157 tokens instead of 4,035 (26×
  low); since tool output is usually the bulk of a long coding session, the guard would let a
  180k-token history through to a 128k model — the very failure it was built to prevent. The
  estimator now recurses into nested content and counts tool-call arguments.
- **A structural chunk silently disabled the fallback chain.** `delegate` marked `produced = true`
  for *any* chunk, but adapters emit `block-start` before their first delta: an adapter that opened
  a block and then failed with a yielded `finish/error` was treated as having already produced
  output, so the chain stopped and the raw provider error surfaced instead of the next tier
  answering. `produced` now tracks content-bearing chunks only (partial output is still never
  retried, so nothing is duplicated).
- **The config write route was CSRF-able.** `POST /tier-router/api/config` is reachable without the
  GUI token and accepted any content type, so a `text/plain` POST — a CORS "simple" request that
  needs no preflight — from any page in the browser could rewrite the routing. It now requires
  `content-type: application/json` (which forces a preflight the server never approves) and
  rejects a mismatched `Origin`/`Host` pair.
- **ASCII keywords matched inside other words.** The heuristic classifier used `includes()`, so
  `hi` fired inside "this"/"which"/"high" and `ok` inside "look"/"book", subtracting a score point
  and routing ordinary requests like "this is broken" to the easy tier. ASCII keywords now need a
  leading word boundary (the 1–2 letter ones also a trailing one), while CJK keeps substring
  matching and inflections still count (`tests`, `running`, `refactoring`).

### Changed

- A failed context-window lookup is no longer cached for the whole session: an unknown window is
  used for a minute before being re-resolved, so a transient provider hiccup cannot permanently
  disable the guard for that route.


All notable changes to `dsh-tier-router` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### Fixed (routing latency)

- **Routing could stall for many seconds, or appear to hang.** With `classifier: llm` the difficulty
  classifier runs *before* the real request is dispatched, and it had no timeout — this machine's
  classifier (`gpudev/qwen3.8-27b-q5`) measured **9.3s warm and 91.3s cold**, and that whole wait
  was added to every new message. The classifier is now bounded by `classifierTimeoutMs`
  (default 4000): on timeout the heuristic decides immediately and the request proceeds, while the
  slow classification keeps running and its answer is cached so the next request is fast.
- **The vision sidecar had the same exposure.** `visionMode: replace` calls the vision model per new
  image before routing (a Codex CLI call here, tens of seconds), with no bound, so a hung provider
  stalled the turn indefinitely. It is now bounded by `visionTimeoutMs` (default 60000), aborted via
  an AbortController *and* raced, so the turn proceeds even if an adapter ignores the signal.

### Added

- **Per-decision routing timings.** Each decision now records `timings.overheadMs` — everything
  spent before the chosen model was called — plus the `prepareMs` / `resolveMs` / `classifyMs` /
  `guardMs` breakdown, and the settings card shows it (`routing 0.03s`, or `routing 4.01s
  (classify 4.0s)` when the classifier was the cost). "The router is slow" is now attributable
  instead of a guess.

## [0.2.0] - 2026-09-16

Answering "which model did it actually use, and what happens when the session outgrows a tier?".

### Added

- **Recent routing decisions** in the settings card and on `GET /tier-router/api/stats`
  (`decisions`): a bounded 20-entry ring recording, per request, the model that answered, the
  classified tier, the estimated request size, the routes tried before it, and why that route won.
  Previously the only record was a `ctx.logger.info` line that this deployment does not surface
  anywhere, so the choice was effectively invisible.
- **`contextGuard`** (default on): before delegating, each candidate route's context window is
  resolved through `resolveModelInfo` and routes whose *known* window is smaller than the estimated
  request size are skipped, so a 180k-token session is no longer handed to a 131k-token model.
  Unknown windows always pass, and the guard never empties a chain.
- `estimatePromptTokens` / `textTokens`: a tokenizer-free request-size estimate (~1 token per CJK
  character, ~3.5 characters per token otherwise, a fixed allowance per image, 10% headroom),
  deliberately biased to over-estimate.
- Context windows in the model catalog and in the picker labels (`qwen3.8-27b-q5 · 131k ctx`), so a
  tier's ceiling is visible while configuring it.
- 7 more tests (92 total) covering the estimator, the skip, unknown windows, fail-open, the
  `contextGuard: false` escape hatch, and the decision ring.

### Fixed

- **`visionCacheTtl` above one hour was silently capped at one hour.** The evidence cache was
  constructed with a hardcoded 1h TTL of its own while the setting only gated writes, so raising
  the setting had no effect. `createDecisionCache` now supports a `0` TTL meaning "the caller owns
  the lifetime" (plus a `getWithAge` accessor), the router builds the vision cache that way, and
  `lib/vision.js` enforces `visionCacheTtl` itself — the setting is now the single authority, and
  `0` disables reads as well as writes.
- **The `fallback` counter was always 0.** It was defined, shown in the card and returned by the
  API, but never recorded. It now counts a request whose answer came from any route other than the
  one the classification asked for, and the card displays it (`Fallbacks` / `回退接管`).

## [0.1.1] - 2026-09-16

Engineering-debt pass: the pieces the 0.1.0 adaptation left behind upstream.

### Added

- **Test suite (85 cases, zero dependencies)** ported from `dsh-smart-router` and
  adapted: `classifier` (14), `config-api` (8), `router` (28), `vision` (18),
  `schema` (10), plus a new `i18n` (4) static guard. Run with `npm test`.
- **Type declarations** (`lib/types/index.d.ts`) describing the bundle entry, the
  resolved settings shape, and the schema helpers; wired through both `types` and
  `exports["."].types`. Upstream declared a `types` field that pointed at a file
  which was never committed — this ships real declarations instead.
- `CHANGELOG.md`, and a Development / Limitations / Compatibility section in both
  READMEs.
- Tests covering behaviours that previously had no coverage at all: the shipped
  default ladder, the `NO_ROUTE` path, and the chat reasoning master switch.

### Changed

- Renamed the adapter class `SmartRouterAdapter` → `TierRouterAdapter`, completing
  the rename that 0.1.0 left half-done.
- Host-visible display strings (model picker name, model description, the
  unconfigured-vision placeholder that reaches the prompt) are now locale-neutral
  English, because the host has no access to the client locale. The settings card
  keeps its own `zh` / `en` tables.
- `npm test` now runs `node --test` (auto-discovery). Upstream's documented
  `node --test tests/` does not work on Node 22.23 — it treats `tests/` as a module
  path and exits with `MODULE_NOT_FOUND`.
- Tests no longer depend on the shipped default routes: the shared `settings()`
  helper blanks every tier so each case states exactly what it configures.

### Fixed

- A Chinese string (`当前设置为只读，无法保存`) had leaked into the **English** locale
  table; the `i18n` test now fails the build if that happens again.
- Upstream's 13 unnamed `test('', …)` cases in `router.test.js` are now named for
  what they assert.

## [0.1.0] - 2026-09-16

First release: an adaptation of [`dsh-smart-router`](https://github.com/rouyiemei/dsh-smart-router)
(MIT) published as `dsh-tier-router`.

### Added

- Virtual provider `tier-router` with a single `smart` model, registered through
  `ctx.llm.registerAdapter` and forwarding with `prepareCall().stream()` — no host
  patches.
- Three-tier difficulty routing (hard / normal / easy) plus a vision tier, with a
  bilingual heuristic classifier and an optional cached LLM classifier.
- Vision sidecar: `replace` mode turns image blocks into structured evidence text
  (summary / OCR / layout / entities) and lets the difficulty tiers answer, with an
  attachment-keyed cache; `route` mode sends the whole turn to the vision tier.
- Ladder fallback (requested tier → remaining tiers, hardest first → default model)
  with fail-open error chunks, and a recursion guard against a tier pointing at the
  router itself.
- Settings section (`tier-router` namespace) with a web settings card, plus a host
  HTTP API under `/tier-router/api/{models,config,stats}`.
- Localized settings card (`zh` / `en`).

### Changed relative to upstream

- Renamed from `dsh-smart-router`; tier defaults retargeted to the author's routes.
- Fixed the client service injection (`dsh-client-runtime` → `dsh-client-ui-renderer`,
  which is what actually provides the `slots` service in this deployment).
- Removed the bundled free-vision provider seeding (`ovh-vision` / `zhipu-vision`).
- Dropped the never-implemented `escalateOnError` setting.
- Dual-language README with English as the npm default (`README.md` +
  `README.zh.md`).
