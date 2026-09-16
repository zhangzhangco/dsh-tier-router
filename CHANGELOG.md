# Changelog

All notable changes to `dsh-tier-router` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
