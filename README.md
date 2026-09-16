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

## Quick start

1. Open the Web GUI → **Settings → Tier Router** and give each of the four tiers a provider + model.
   The pickers list every model you have configured, with `✓ Vision` and reasoning-effort metadata.
2. Pick **Tier Router (auto)** as the session model in the chat model selector.
3. Send messages as usual. Route counters and recent failures are on the same settings page.

> The defaults in this repository point at the author's own local routes (`codex-local`, `gpudev`).
> Set the four tiers to your own models. Tiers left empty are skipped automatically and the request
> falls back — nothing breaks.

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
| `hardProvider` / `hardModel` / `hardEffort` | `codex-local` / `gpt-6-astra` / `''` | Hardest tier. |
| `normalProvider` / `normalModel` / `normalEffort` | `codex-local` / `gpt-5.5` / `''` | Everyday tier. |
| `easyProvider` / `easyModel` / `easyEffort` | `gpudev` / `qwen3.8-27b-q5` / `''` | Cheapest tier. |
| `visionProvider` / `visionModel` / `visionEffort` | `codex-local` / `gpt-6-astra` / `''` | Image tier. |
| `visionMode` | `replace` | Image handling; see below. |
| `visionCacheTtl` | `3600` | Vision-evidence cache in seconds. |
| `visionFallbacks` | `[]` | Explicit vision fallbacks before the default model. |
| `fallbackProvider` / `fallbackModel` | `''` | Route used when no tier is configured; empty = session default. |
| `llmClassifierProvider` / `llmClassifierModel` | `''` | Classifier model for `classifier: llm`. |

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

## HTTP API

The settings card talks to these host endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/tier-router/api/models` | Model catalog for every provider (image support, reasoning efforts) + current default model. |
| `GET` | `/tier-router/api/config` | Resolved settings + defaults + writability. |
| `POST` | `/tier-router/api/config` | Write one field (`{field, value}`); `value: null` resets it. |
| `GET` | `/tier-router/api/stats` | Route counters and recent failures. |

The client half reads and writes through this API rather than the settings wire, because the host only
exposes allow-listed namespaces to configuration clients.

## Requirements

- `@deepseek-ai/dsh-llm` `^0.1.5-rc.2` — adapter routing and `contentHasImage`
- `@deepseek-ai/dsh-settings` `^0.1.5-rc.2` — `installSection`
- `@deepseek-ai/cordis` `^4.0.2`
- `@deepseek-ai/schemastery` `^3.18.2`
- The client half contributes a `settings.section` entry and therefore loads only on `platform: web`.

## Credits

This package is adapted from [dsh-smart-router](https://github.com/rouyiemei/dsh-smart-router) (MIT):
the routing model, the difficulty classifier, the vision sidecar and the settings-card architecture
originate there. This adaptation renames the plugin, retargets the tier defaults, fixes the client
service injection, and drops the bundled free-vision provider seeding.

## License

[MIT](./LICENSE).
