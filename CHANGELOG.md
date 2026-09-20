# Changelog

## [0.5.0] - 2026-09-20

The heuristic's hard threshold becomes a setting — together with the measurement showing why the
knob is not the fix.

### Added

- **`hardScore`** (default `3`) — `classifyDifficulty` now takes its hard cut-off as an argument,
  exposed as a setting and as a number input in the settings card (disabled under `classifier: llm`,
  where the score plays no part). The schema clamps it to 0..10: the score test is the first branch,
  so a negative cut-off would classify every greeting as hard.
- Both READMEs document the measurement behind it, because a tunable threshold invites the
  assumption that tuning it improves routing. It does not — on 213 real requests 79% scored exactly
  0 and nothing landed between 2 and 6, so 2/3/4/5 behave identically and only 3 (1 hard in 213) and
  1 (12) differ. The score does not separate hard work from routine work.

### Fixed

- **The README instructed readers to run a script that no longer exists.** The
  `node benchmarks/evaluate-routing.mjs` line survived the logits removal in 0.4.0 and shipped
  inside the 0.4.0 tarball.

## [0.4.0] - 2026-09-20

Bounded evidence for classification, two heuristics for cases keywords cannot see, and the removal
of the local option-scoring classifier.

### Added

- **Classification reads a bounded evidence envelope instead of one message.** `lib/routing-state.js`
  builds a ≤6000-character JSON state — current task, recent conversation, current-turn tool calls
  and results, structured failure counts, estimated tokens, image flag — and omits private reasoning
  and plugin snapshots. Downstream messages are unchanged. `lib/routing-cache.js` adds SHA-256 cache
  keys over the full input plus backend identity, in-flight request sharing, and per-waiter
  cancellation isolation.
- **Two heuristic rules for what keywords cannot see.** A short continuation (`继续`, `continue`, …)
  inherits the previous task's tier; a repeated structured tool failure for the same call is at least
  `hard`. Both work when no semantic classifier is reachable.
- `agentStep` and `toolErrorCount` are recorded per decision, and the settings card shows the
  per-turn denominator next to the per-request counters.

### Removed

- **The local logits option scorer** (`classifier: logits`), its `logits*` settings, the
  `logitsShadow` comparison checkbox and the `experiments` stats block. Its verdict flipped with
  candidate option order while still reporting near-maximum confidence, so the score could not be
  used as a gate; see [benchmarks/RESULTS.md](./benchmarks/RESULTS.md). Configurations that still
  set a retired field are rejected by the config API rather than silently accepted.

### Changed

- `classifier` is now a closed union (`heuristic` | `llm`); an unknown value is rejected.
- The settings card is grouped into titled sections (Basics / Tier models / Vision / Fallback /
  Status / Recent decisions) instead of a single run of cards. Status counters render as a grid, and
  each decision is a headline plus a muted explanation rather than a dozen concatenated fields.

## [0.3.1] - 2026-09-17

Injected context is a user-role message too, and it was the one being classified.

### Fixed

- **The classifier was reading agent-loop snapshots instead of the human's message.** 0.2.3 taught
  `lastUserText` to skip tool results (also `role: 'user'`), but dsh-llm has a third user-role
  producer: plugin-injected context — `instructions`, `catalog`, `snapshot`, `notice`, `relay`,
  `recall` — created with `createUserMessage({ source: { kind: 'plugin', form: 'snapshot' } })`. The
  agent loop appends a fresh `snapshot` after every turn, so the backwards search landed on injected
  state. The live symptom was an LLM classifier answering
  *"No explicit request text is shown; the surrounding context suggests a small follow-up feature, so
  default to normal"* against a 2000-character input, on every request of the turn.
  Identification is now **positive**: the human message is the one whose `source.kind === 'user'`,
  which is what the client connection tags a typed prompt with. A recognised non-human source is
  always rejected; an absent source (hand-built requests) still falls back to structure.
- `isHumanMessage` is exported.

### Notes

- This also makes the turn identity correct in the presence of injected context: the human message's
  index no longer moves when the loop appends a snapshot, so `turns` and `same turn` stay right.

4 new tests (146 -> 150).

## [0.3.0] - 2026-09-17

A tier that cannot serve a request is not a tier that failed once. The router now reacts to the
harness failure code instead of only advancing the chain.

### Added

- **Failure-code routing.** `HarnessError.code` is the harness's stable machine-routable failure
  class, and its contract says to route on it rather than parse the message. The router does:
  `QUOTA` / `AUTH` / `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` / `NO_ADAPTER` mean "this route
  cannot serve" and bench it immediately, while `TRANSPORT` / `TIMEOUT` / `SERVER` / `RATE_LIMIT` /
  `EMPTY_RESPONSE` and unknown codes only bench after `routeFailureThreshold` consecutive failures.
- **Benched routes (`routeCooldownMs`, default 300000; `routeFailureThreshold`, default 2).** A
  benched route is skipped outright instead of paying its failure again on the next request, and
  Settings → Tier Router lists it with the code, message and seconds remaining (`benched` in the
  stats payload). Any success clears the streak; `0` disables the bench.
- `CONTEXT_WINDOW_EXCEEDED` and `ABORTED` never bench a route: they describe the request, not the
  route's health.
- The failure ring now keeps each failure's `code` next to its message.
- `failureCodeOf`, `failureMessageOf` and `TierRouterAdapter#benchedRoutes` are exported.

### Notes

- **The bench is fail-open**, exactly like the context guard: if every route is benched the chain is
  used anyway, with the reason kept in the decision's `skipped` list. It must never turn a routable
  request into `NO_ROUTE`.
- **This stops the bleeding from the second request onward.** The first one still waits out whatever
  the adapter costs before reporting failure — no code can arrive sooner than the failure does.
  Bounding that first request needs a timeout inside the adapter (`dsh-llm-codex`'s `timeoutMs`,
  default 10 minutes per `codex exec`).
- **Why the streak rule exists:** an exhausted quota can surface as nothing but a connection timeout.
  A real Codex CLI failure carried the entire diagnostic `Reconnecting... 2/5 (request timed out)`,
  which the harness quota classifier does not match — parsing cannot recover a signal that was never
  emitted, so repeated failure is the fallback signal.

8 new tests (136 -> 144, plus 2 at the HTTP boundary).

## [0.2.3] - 2026-09-17

The classifier was reading the wrong message. On any request after the first in a turn it was handed
an empty string, so `normal` was not a judgement — it was the default value of `level`. This is what
made a live instance report 3 hard / 112 normal / 1 easy.

### Fixed

- **A tool result was mistaken for the newest user message.** `ToolResultMessage` is declared
  `role: 'user'` with content `[ToolResultBlock]`, so the backwards search for the latest user
  message landed on the tool output of the previous step. `blocksText` of that message is `''`, so
  every tool-loop step skipped classification entirely and kept the default `normal`; only the first
  request of each turn was ever classified. `lastUserText` now skips tool results (by declared
  `source.kind` and, for hand-built requests, by block shape) and reads the newest human message,
  falling back to the nearest earlier human text when the newest carries none (an image-only turn).
  Tool steps of one turn now share one classification, which is also what makes the per-request
  counters mean anything.
- **Auxiliary model calls were counted as human turns and as `normal` difficulty.** A request with no
  human message (session title, compaction) has no turn identity, and `recordTurn(undefined, …)`
  counted every one of them as a fresh turn. Such a request is now neither a turn nor a contribution
  to the difficulty mix: its `normal` is the default value of `level`, not a judgement. The
  `decisions` ring still logs it, with `turn: false` and `by none`.

### Added

- `lastUserText` and `isToolResultMessage` are exported for testing.

## [0.2.2] - 2026-09-17

The routing counters could not answer "is this difficulty mix reasonable?", and nothing on the card
said why a tier had been chosen. Both are fixed; 13 new tests (115 → 128).

### Added

- **Per-turn counters (`turns`), next to the per-request ones.** An agent loop re-sends the same
  classified message on every tool step, and the classification is cached by message text, so
  counting requests measures loop length rather than the mix of work: with the old counters a
  four-step loop plus a follow-up read as five samples of one task. A turn is now identified by the
  last user message (session + its index in the request), so the settings card can show the
  denominator that actually answers the question. Both are kept and labelled — a request count is
  still the right number for "how much traffic did each tier serve".
- **`by <classifier>` on every decision**: `llm`, `llm-cache`, `heuristic`, `llm-timeout`,
  `llm-error` or `llm-unavailable`. Previously a level that came from the heuristic because the LLM
  classifier had timed out, failed, or was never configured was indistinguishable from a real
  classification.
- **`why: …` on every decision**: the classifier's own one-sentence reason, or the heuristic's
  scoring reasons. `resolveChain` had always computed this `cause` and `recordDecision` had never
  written it, so the card showed the route reason (`normal tier`) and nothing about the judgement.
- **`decided from N chars` next to the token estimate.** The classifier reads only the latest user
  message (bounded to 2000 characters) while the request carries the whole history; putting the two
  numbers side by side makes a tier decided from 2 characters out of a 39k-token request visible
  instead of inexplicable.
- `fingerprint`: a stable hash of the classification input, so identical inputs are recognisable
  across decisions. `GET /tier-router/api/stats` exposes all of the above.

### Fixed

- **A recovered route failure was reported as zero errors.** `recordError` wrote the failure ring
  but never touched `counts.error`, which only counts requests nothing could answer — so the card
  read `Errors 0` directly above a list of four failures. The failures now also increment
  `routeError`, and the two counters are labelled `Unrecovered errors` and `Route failures
  (recovered)`.

### Changed

- `classifyWithLlm` resolves to `{ level, reason, source }` instead of `undefined` on failure, so
  the caller reports how the level was reached rather than guessing it back from the elapsed time.

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
