# dsh-tier-router

[![npm](https://img.shields.io/npm/v/dsh-tier-router.svg)](https://www.npmjs.com/package/dsh-tier-router)
[![license](https://img.shields.io/npm/l/dsh-tier-router.svg)](./LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)

**Tier-based automatic model routing for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

It registers one virtual model — **Tier Router (auto)** — that you select as your session model.
Every request is then classified by **difficulty** (hard / normal / easy) and by **whether it contains
images**, and delegated to the models you already configured in *Settings → Models*.

No extra upstream, no extra API key: the routing targets are your existing models — a local Codex
route, a llama.cpp endpoint, an official API, anything.

[中文说明 →](./README.zh.md)

## Why

Model pickers make you choose once and live with it: pick the strong model and you pay for it on
"thanks, continue"; pick the cheap local model and it fumbles the hard refactor. `dsh-tier-router`
makes that choice per request instead:

- greetings, translations and short explanations → your **easy** tier (e.g. a free local model)
- ordinary coding and file work → your **normal** tier
- architecture, debugging, concurrency, migrations → your **hard** tier
- anything with an image → your **vision** tier, with the image turned into structured text first

## Features

- **Three-tier difficulty routing** — heuristic classifier (default: zero cost, zero latency,
  deterministic) or an optional LLM classifier with caching.
- **Vision sidecar** — when a request carries images, a vision model converts them into structured
  evidence (summary / OCR / layout) that replaces the image block as text; the difficulty tiers then
  answer. A legacy `route` mode sends the whole turn to the vision tier instead.
- **Ladder fallback** — requested tier → remaining tiers (hardest first) → your default model.
- **Fail-open** — an error finish chunk is only emitted when every route failed; requests are never
  silently swallowed.
- **No forks, no patches** — pure adapter-level routing (`ctx.llm.registerAdapter` + `prepareCall`);
  the Harness source is untouched.
- **Built-in settings card** — pick each tier from a live model catalog (annotated with image support
  and available reasoning efforts) in *Settings → Tier Router*, and watch route counters and recent
  failures.
- **Two-level reasoning effort** — the chat selector (Off / High) is the master switch; when it is on,
  each tier uses the effort you configured for it.
- **Recursion-safe** — a tier that points at the router itself is skipped, so routing can never loop.

## Install

```sh
dsh plugin --profile web add dsh-tier-router
```

Then restart `dsh web` (host plugins load at boot). The package declares `dsh.bundle.patch`, so
`dsh plugin add` appends it to the profile's layer stack and its own `cordis.patch.yml` inserts the
plugin row — do **not** add a second row by hand.

Installing straight from GitHub also works (this package is plain ESM with no build step):

```sh
dsh plugin --profile web add github:zhangzhangco/dsh-tier-router
```

**Updating.** `dsh plugin add` records a caret range, and for a `0.x` version a caret pins the
*minor*: `^0.1.0` can never resolve to `0.2.0`. Ask for the version (or the tag) explicitly:

```sh
dsh plugin --profile web add dsh-tier-router@latest
```

Right after a release, a local install can still resolve the previous version from pnpm's cached
registry index; pinning the exact version (`dsh-tier-router@0.2.0`) always re-fetches.

## Quick start

1. Open the Web GUI → **Settings → Tier Router** and give each of the four tiers a provider + model.
   The pickers list every model you have configured, with `✓ Vision` and reasoning-effort metadata.
2. Pick **Tier Router (auto)** as the session model in the chat model selector.
3. Send messages as usual. Route counters and recent failures are on the same settings page.

> The defaults in this repository point at the author's own local routes (`codex-local`, `gpudev`).
> Set the four tiers to your own models. Tiers left empty are skipped automatically and the request
> falls back — nothing breaks.

## How do I see which model was chosen?

Open **Settings → Tier Router**. Below the counters, **Recent routing decisions** lists the last 20
requests, newest first, each showing the model that answered, the classified tier, the estimated
request size, and why that route won:

```
21:47:12  codex-local/gpt-5.6-terra  ·  hard  ·  ~181k tok  ·  by heuristic  ·  new turn  ·  hard tier  ·  why: 3 hard signal(s)
21:46:40  gpudev/qwen3.8-27b-q5  ·  easy  ·  ~2k tok  ·  by heuristic  ·  same turn  ·  easy tier  ·  why: social signal(s) in short message
21:45:03  codex-local/gpt-5.5  ·  normal  ·  ~181k tok  ·  by llm-cache  ·  same turn  ·  normal tier  ·  skipped (window too small) gpudev/qwen3.8-27b-q5 (131072 < est 181000, easy tier (fallback))
```

Three fields exist specifically to make a surprising tier explainable:

- **`by <classifier>`** — which classifier produced the level: `llm`, `llm-cache`, `heuristic`,
  `llm-timeout`, `llm-error` or `llm-unavailable`. A tier that came from the heuristic because the
  LLM classifier timed out or was never configured says so instead of being indistinguishable from a
  real classification.
- **`why: …`** — the classifier's own one-sentence reason, or the heuristic's scoring reasons. The
  route reason (`normal tier`) answers *where* the request went; this answers *why* it was judged
  that way.
- **`why: …`** — the classifier's own reason: either the sentence the LLM classifier gave, or the
  heuristic's scoring reasons. It answers "why this tier" where the route reason answers "which tier".

### Two denominators, on purpose

The counters row counts **requests**; the `Per turn` line below it counts **human turns**.

Inside an agent loop one human message is re-sent on every tool step, and the classification is
cached by bounded state and backend identity, so changed tool evidence can select a new tier. A per-request count is therefore
weighted by how many steps a task happened to take — it mostly measures loop length, not the mix of
work. A turn is identified by the last user message (its session plus its index in the request), so a
five-step tool loop is one turn and a follow-up message is the next one.

Read the per-turn line to judge whether the difficulty mix is reasonable; read the per-request line
to see how much traffic each tier actually served. When the two disagree sharply, the request
denominator is being dominated by a few long loops.

The `skipped` note is the context guard at work: that tier was passed over because its model could not
hold the request. The same data is on the stats endpoint:

```sh
curl -s localhost:3080/tier-router/api/stats | python3 -m json.tool
```

`decisions` is a bounded in-memory ring (20 entries) — it resets when the server restarts, and it
records the router's own view, not a billed token count.

## Long sessions and small-context models

A session grows, and a model that answered an early turn may no longer fit the current history — the
classic failure is a local `llama.cpp` endpoint with a 131k window handed a 180k-token conversation:

```
400: request (180612 tokens) exceeds the available context size (131072 tokens)
```

`contextGuard` (on by default) handles that **before** the request is sent. For every candidate route
the router resolves the model's context window (`resolveModelInfo().context.contextWindow`) and skips
any route whose **known** window is smaller than the estimated request size, so the ladder falls
through to a model that fits. Three properties matter:

- **Unknown windows never block.** A provider that reports no window is always a candidate; the guard
  only ever drops a model whose limits it actually knows.
- **It never empties a chain.** If every route would be skipped, the original chain is used unchanged —
  a routable request can never become "no route".
- **It is an estimate.** The request size is approximated as ~1 token per CJK character and ~3.5
  characters per token elsewhere (images add a fixed allowance), with 10% headroom. It is deliberately
  biased to over-estimate, because guessing low sends a request a model cannot hold.

Set `contextGuard: false` to route purely by difficulty and tier order. The model pickers also show
each model's window (`qwen3.8-27b-q5 · 131k ctx`), so you can see which tiers can hold a long session
when you configure them.

## Configuration

Settings live in the `tier-router` namespace as flat fields. Edit them in the settings card or write
them directly:

```yaml
tier-router:
  enabled: true
  classifier: heuristic          # heuristic | llm
  hardProvider: codex-local
  hardModel: gpt-6-astra
  hardEffort: ''                 # e.g. low / high / max; empty = unspecified
  normalProvider: codex-local
  normalModel: gpt-5.5
  normalEffort: ''
  easyProvider: gpudev
  easyModel: qwen3.8-27b-q5
  easyEffort: ''
  visionProvider: codex-local
  visionModel: gpt-6-astra
  visionEffort: ''
  visionMode: replace            # replace (structured evidence, default) | route (whole turn)
  visionCacheTtl: 3600           # seconds of vision-evidence cache; 0 disables
  visionFallbacks: []            # [{provider, model}] explicit vision fallbacks
  fallbackProvider: ''           # last resort; empty = the session default model
  fallbackModel: ''
  llmClassifierProvider: ''      # classifier: llm; empty = reuse the easy tier
  llmClassifierModel: ''
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; when off, requests go to the session default model. |
| `classifier` | `heuristic` | `heuristic` (built-in scoring) or `llm` (a model decides the tier). |
| `hardScore` | `3` | Heuristic only: score at or above which a request is `hard`. See the note below before changing it. |
| `hardProvider` / `hardModel` / `hardEffort` | `codex-local` / `gpt-6-astra` / `''` | Hardest tier. |
| `normalProvider` / `normalModel` / `normalEffort` | `codex-local` / `gpt-5.5` / `''` | Everyday tier. |
| `easyProvider` / `easyModel` / `easyEffort` | `gpudev` / `qwen3.8-27b-q5` / `''` | Cheapest tier. |
| `visionProvider` / `visionModel` / `visionEffort` | `codex-local` / `gpt-6-astra` / `''` | Image tier. |
| `visionMode` | `replace` | Image handling; see below. |
| `visionCacheTtl` | `3600` | Vision-evidence cache in seconds. |
| `visionFallbacks` | `[]` | Explicit vision fallbacks before the default model. |
| `fallbackProvider` / `fallbackModel` | `''` | Route used when no tier is configured; empty = session default. |
| `llmClassifierProvider` / `llmClassifierModel` | `''` | Classifier model for `classifier: llm`. |
| `classifierTimeoutMs` | `4000` | Budget for the LLM classifier. On timeout the heuristic decides immediately and the slow answer is cached for later requests. |
| `visionTimeoutMs` | `60000` | Budget for one vision-sidecar call, so a hung vision provider cannot stall the turn. |
| `contextGuard` | `true` | Skip routes whose known context window cannot hold the request. |

### The `hardScore` knob, and why it is not a fix

Measured on 213 real requests from one machine, the heuristic score distribution was degenerate:

| Score | Requests |
| ---: | ---: |
| 6 | 1 |
| 2 | 1 |
| 1 | 10 |
| **0** | **169 (79%)** |
| -1 | 32 |

Nothing landed between 2 and 6, so `hardScore` values 2, 3, 4 and 5 behave identically. Only two
settings do anything: `3` (the default — 1 request in 213 became `hard`) and `1` (12 did). `0` is
safe for small talk because greetings score -1, and the schema clamps the value to 0..10 — a
negative cut-off would classify every greeting as `hard`.

The knob is useful for choosing how aggressive to be, **not** for accuracy: 79% of requests sit in
one bucket, so no threshold separates hard work from routine work. If routing quality is the goal,
use `classifier: llm` instead.

## How routing works

```
request ──► has images?
             ├─ yes ─► visionMode=replace: images → vision model → structured evidence text ─┐
             │         visionMode=route:   whole turn → vision tier                        │
             └─ no ───────────────────────────────────────────────────────────────────────┤
                                                                                            ▼
                                              difficulty classification (heuristic/LLM) ─► tier chain
                                              chosen tier → other tiers (hardest first) → default model
```

**Difficulty signals** are bilingual (English + Chinese): code-fence volume, number of file
references, message length, and keywords such as *architecture, refactor, concurrency, deadlock,
memory leak, distributed, migration, performance, security…*. A score of **3 or more** is `hard`; a
message containing a task verb is at least `normal`; greetings, translations and short explanations
are `easy`.

Two behaviours worth knowing:

- **Image history counts.** The request carries the whole conversation, so if *any* message contains
  an image the request is treated as a vision request — otherwise a text-only tier model would reject
  the history with "does not support image input".
- **`visionMode`.** `replace` (default) keeps the vision model as an assistant only: it returns
  structured evidence, that text replaces the image, and the difficulty tiers produce the answer.
  `route` is the legacy behaviour: the whole turn goes to the vision tier.

## When a model is unavailable

A tier that cannot serve a request is not the same as a tier that failed once. The router reads the
harness failure code (`HarnessError.code` — the contract is explicit that callers route on the code
and never parse the message) and reacts differently:

| Failure | Codes | What the router does |
| --- | --- | --- |
| **The route cannot serve** | `QUOTA`, `AUTH`, `INVALID_CREDENTIAL`, `MISSING_CREDENTIAL`, `NO_ADAPTER` | Advance the chain **and bench the route** for `routeCooldownMs` (default 5 min). |
| **Something went wrong once** | `TRANSPORT`, `TIMEOUT`, `SERVER`, `RATE_LIMIT`, `EMPTY_RESPONSE`, unknown | Advance the chain, but bench only after `routeFailureThreshold` (default 2) consecutive failures inside the window. |
| **About this request, not the route** | `CONTEXT_WINDOW_EXCEEDED`, `ABORTED` | Advance the chain and never bench: the next, smaller request may well fit. |

A benched route is skipped outright — its failure is not paid again — and Settings → Tier Router
lists it with the code, the message and the seconds until it is retried:

```
Benched routes (judged unavailable): codex-local/gpt-6-astra — QUOTA (usage limit reached), 274s retry in
```

Any success clears the route's streak, `routeCooldownMs: 0` turns the bench off, and the bench is
never allowed to empty the chain: if *every* route is benched the chain is used anyway, with the
reason kept in the decision's `skipped` list (fail-open, like the context guard).

**The streak rule exists because the code is not always informative.** An exhausted account quota can
surface as nothing but a connection timeout, because that is all the provider or its CLI ever said —
measured on a real Codex CLI failure whose entire diagnostic was `Reconnecting... 2/5 (request timed
out)`. No amount of message parsing recovers a signal that was never emitted, so the router falls
back to "the same route failed twice in a row".

**The honest limit:** this stops the bleeding from the *second* request onward. The first one still
waits out whatever the adapter costs before it reports failure, and no failure code can arrive sooner
than the failure does. Bounding that first request needs a timeout *inside the adapter* (for
`dsh-llm-codex`, the `timeoutMs` field of its provider entry, default 10 minutes per `codex exec`).

## HTTP API

The settings card talks to these host endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/tier-router/api/models` | Model catalog for every provider (image support, reasoning efforts) + current default model. |
| `GET` | `/tier-router/api/config` | Resolved settings + defaults + writability. |
| `POST` | `/tier-router/api/config` | Write one field (`{field, value}`); `value: null` resets it. Requires `content-type: application/json` and a same-origin `Origin`/`Host` pair, so a page you merely visit cannot rewrite the routing. |
| `GET` | `/tier-router/api/stats` | Route counters (`hard`/`normal`/`easy`/`vision`/`visionBridge`/`fallback`/`error`/`routeError`) plus the per-turn counters in `turns`, the recent failure ring in `errors`, and the recent decision ring in `decisions`, and the routes currently benched in `benched`. `error` counts requests nothing could answer; `routeError` counts individual route failures, including the ones the fallback chain recovered. |

The client half reads and writes through this API rather than the settings wire, because the host only
exposes allow-listed namespaces to configuration clients.

## Requirements

- `@deepseek-ai/dsh-llm` `^0.1.5-rc.2` — adapter routing and `contentHasImage`
- `@deepseek-ai/dsh-settings` `^0.1.5-rc.2` — `installSection`
- `@deepseek-ai/cordis` `^4.0.2`
- `@deepseek-ai/schemastery` `^3.18.2`
- The client half contributes a `settings.section` entry and therefore loads only on `platform: web`.

## Limitations and compatibility

Worth knowing before you rely on it:

- **The vision sidecar is cached, not free.** Every request whose history contains an image calls
  (or reuses a cached call to) the vision model. Evidence is cached per attachment for
  `visionCacheTtl` seconds (default 1h); after that the same historical image is analysed again on
  the next request. Set `visionCacheTtl: 0` to disable the cache.
- **An image anywhere in the history keeps the request image-bearing.** That is deliberate (a
  text-only tier model would otherwise reject the whole history), and in `replace` mode the
  difficulty tiers still produce the answer — the vision model only supplies evidence. But a long
  session that once had a screenshot keeps paying for vision evidence until that turn leaves the
  conversation.
- **The heuristic is conservative.** A hard verdict needs a score of 3 or more; two hard keywords
  alone land at `normal`. Retarget the tiers, or switch `classifier` to `llm`.
- **This router only acts when you select it.** It routes requests made *through* the `smart` model,
  so it is opt-in per session.
- **Do not run it together with a plugin that force-overrides the model** on the `agent/request`
  waterfall (role-based routers that stamp planner/executor models after `await next()`). Such a
  plugin outranks the model selector, so Tier Router would never receive a request. Pick one.
- **Dependencies are peers.** `@deepseek-ai/dsh-llm`, `dsh-settings` and `cordis` come from the DSH
  installation; the only bundled dependency is `@deepseek-ai/schemastery`.

## Development

```sh
git clone https://github.com/zhangzhangco/dsh-tier-router
cd dsh-tier-router
npm install --legacy-peer-deps   # pulls the public @deepseek-ai/* peers
npm test                         # 85 cases, node:test, no test framework
```

`npm test` runs Node's built-in runner (`node --test`, auto-discovery). Note that
`node --test tests/` — the form upstream documented — does not work on Node 22.23: it treats the
directory as a module path and exits with `MODULE_NOT_FOUND`.

To run the checkout in a profile instead of the published package:

```sh
dsh plugin --profile web remove dsh-tier-router
dsh plugin --profile web add link:/absolute/path/to/dsh-tier-router
```

Layout: `index.js` (bundle entry), `lib/{schema,router,classifier,vision,models-api}.js`,
`lib/types/index.d.ts` (hand-written TypeScript declarations), `client/client.js` (the settings card,
a build-free `window.__ModuleLoader__` bundle), `cordis.patch.yml` (the bundle layer), `tests/`.

## Credits

This package is adapted from [dsh-smart-router](https://github.com/rouyiemei/dsh-smart-router) (MIT):
the routing model, the difficulty classifier, the vision sidecar and the settings-card architecture
originate there. This adaptation renames the plugin, retargets the tier defaults, fixes the client
service injection, and drops the bundled free-vision provider seeding.

## License

[MIT](./LICENSE).


### State-aware classification

The default remains `heuristic`. Select `llm` and configure `llmClassifierProvider/Model` to use the
generation-based classifier with task and step evidence. Inputs omit private reasoning and plugin
snapshots; actual downstream messages remain unchanged. `agentStep` counts current-turn tool calls,
and failures require structured `isError` flags.

The heuristic also covers two cases keywords cannot: a short continuation (`继续`, `continue`, …)
inherits the previous task's tier, and a repeated structured tool failure for the same call is at
least `hard`.

SHA-256 cache keys include the complete bounded input, backend/model and prompt. Concurrent identical
work is shared; caller cancellation is isolated, late results stay keyed to their original state, and
background work is capped at 30 seconds / 32 pending keys. Only bounded diagnostics are retained in
memory.

A local option-scoring classifier (`classifier: logits`) was prototyped and then removed: its verdict
flipped with candidate option order while still reporting near-maximum confidence, which makes the
score unusable as a gate. See [the decision record](benchmarks/RESULTS.md) for the measurements and
for what was **not** verified.

End-to-end task quality, latency and cost still need separate controlled runs; nothing in this
repository establishes an accuracy claim for either classifier.
