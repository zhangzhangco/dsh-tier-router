/**
 * Tier Router core: a virtual LLM provider that routes every request.
 *
 * Architecture (参考 llm-adaptive / dsh-vision-mix 的 adapter 级路由):
 * - 注册一个虚拟 provider `tier-router` + 模型 `smart`，模型声明
 *   `inputModalities: ['text', 'image']`，因此 DSH 的图片准入
 *   （MODEL_DOES_NOT_SUPPORT_IMAGES）在 preflight 阶段直接放行；
 * - `stream(options)` 在每次请求时：消息含图 → 视觉侧车（vision sidecar）
 *   把图块分割出去、由视觉模型返回结构化证据替换回文本（默认 `replace`
 *   模式，视觉模型只辅助不主导），纯文本再按难度分类（启发式默认 /
 *   LLM 可选）→ 对应档位模型；`route` 模式保留旧的整段路由到视觉档；
 * - 转发统一走 `ctx.llm.prepareCall({provider, model}).stream(forwarded)`，
 *   透传 DSH 的流式 chunk 协议；档位缺失按阶梯回退，最后回退默认模型，
 *   全部失败才产出 error finish chunk（fail-open，绝不静默吞错）。
 */

import { LlmAdapter, contentHasImage } from '@deepseek-ai/dsh-llm'
import {
  DEFAULTS, MODEL, PROVIDER, TIER_ORDER,
  fallbackRoute, normalizeRoute, routeConfigured, tierRoute,
} from './schema.js'
import { CLASSIFIER_SYSTEM_PROMPT, classifierRoute, classifierUserPrompt, classifyDifficulty, parseClassifierReply } from './classifier.js'
import { messagesHaveImage, replaceImages } from './vision.js'

/**
 * Fraction of a model's context window a request may occupy. The estimate is
 * a heuristic rather than a token count, and adapters add their own framing,
 * so routing aims for 90% of the window instead of the exact limit.
 */
const CONTEXT_HEADROOM = 0.9

/**
 * Chunk types that carry model output the caller can already see. Falling back
 * to another route after one of these would duplicate partial output, so they
 * are what `produced` means in `delegate`. Structural/metadata chunks
 * (`block-start`, `block-end`, `usage`, …) deliberately do NOT count.
 */
const CONTENT_CHUNK_TYPES = new Set([
  'text', 'text-delta', 'reasoning', 'reasoning-delta', 'tool-call', 'tool-call-delta',
])

/**
 * How long an unresolved context window is trusted as "unknown" before being
 * looked up again. A successful lookup is stable for the process; a failure is
 * usually a transient provider hiccup, and caching it forever would silently
 * disable the context guard for that route for the rest of the session.
 */
const CONTEXT_WINDOW_RETRY_MS = 60_000

/**
 * Default budget for the LLM difficulty classifier. Classification runs before
 * the real request is dispatched, so an unbounded classifier adds its full
 * latency to every message — measured at ~9s for a warm local 27B and ~91s
 * when that model was cold, which the user experiences as the router hanging.
 */
const CLASSIFIER_TIMEOUT_MS = 4000

/** Returned by `raceTimeout` when the work outlived its budget. */
const TIMED_OUT = Symbol('timed-out')

/**
 * Await `promise`, giving up after `ms`. Resolves the TIMED_OUT sentinel on
 * expiry (the promise itself keeps running and is never left unobserved).
 */
async function raceTimeout(promise, ms) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** In-memory route statistics, surfaced by the settings card. */
export function createStats() {
  const counts = { hard: 0, normal: 0, easy: 0, vision: 0, visionBridge: 0, fallback: 0, error: 0 }
  const errors = []
  const decisions = []
  return {
    counts,
    record(kind) {
      if (kind in counts) counts[kind] += 1
    },
    /**
     * Record one route failure (prepare-time throw OR a terminal error chunk
     * the delegated adapter streamed back). Bounded ring buffer so the
     * settings card and the stats API can show the most recent failures.
     */
    recordError(target, message) {
      errors.push({
        at: new Date().toISOString(),
        target: String(target ?? ''),
        message: String(message ?? '').slice(0, 300),
      })
      if (errors.length > 8) errors.shift()
    },
    /**
     * Record one resolved routing decision — the answer to "which model
     * actually handled that request?". Bounded ring buffer, newest last, so
     * the settings card can show the recent history instead of counters only.
     *
     * @param {object} entry - the decided route.
     * @param {string} [entry.kind] - `text`, `vision` or `none`.
     * @param {string} [entry.level] - the classified difficulty tier.
     * @param {string} [entry.provider] - the provider that answered.
     * @param {string} [entry.model] - the model that answered.
     * @param {string} [entry.effort] - the reasoning effort applied, if any.
     * @param {string} [entry.reason] - why this route won (tier / fallback / default).
     * @param {string} [entry.outcome] - `ok`, or `failed` when nothing answered.
     * @param {string[]} [entry.tried] - targets attempted before this one.
     */
    recordDecision(entry) {
      decisions.push({
        at: new Date().toISOString(),
        kind: String(entry?.kind ?? 'text'),
        level: String(entry?.level ?? ''),
        provider: String(entry?.provider ?? ''),
        model: String(entry?.model ?? ''),
        effort: String(entry?.effort ?? ''),
        reason: String(entry?.reason ?? ''),
        outcome: entry?.outcome === 'failed' ? 'failed' : 'ok',
        tried: Array.isArray(entry?.tried) ? entry.tried.map(String).slice(0, 8) : [],
        estimate: Number.isFinite(entry?.estimate) ? entry.estimate : 0,
        skipped: Array.isArray(entry?.skipped) ? entry.skipped.map(String).slice(0, 6) : [],
        // Where the routing time went. `overheadMs` is the part the user feels
        // as "the router is slow": everything spent before the chosen model is
        // called. Kept as plain numbers (never live objects).
        timings: {
          overheadMs: Number.isFinite(entry?.timings?.overheadMs) ? Math.round(entry.timings.overheadMs) : 0,
          prepareMs: Number.isFinite(entry?.timings?.prepareMs) ? Math.round(entry.timings.prepareMs) : 0,
          resolveMs: Number.isFinite(entry?.timings?.resolveMs) ? Math.round(entry.timings.resolveMs) : 0,
          classifyMs: Number.isFinite(entry?.timings?.classifyMs) ? Math.round(entry.timings.classifyMs) : 0,
          guardMs: Number.isFinite(entry?.timings?.guardMs) ? Math.round(entry.timings.guardMs) : 0,
        },
      })
      if (decisions.length > 20) decisions.shift()
    },
    snapshot() {
      return { ...counts, errors: [...errors], decisions: [...decisions] }
    },
  }
}

/** Small bounded LRU-ish cache for LLM classification decisions. */
export function createDecisionCache(ttlMs = 120_000, maxEntries = 200) {
  const entries = new Map()
  return {
    /**
     * The live entry (`{ value, at }`) without TTL enforcement, for callers
     * that own the lifetime themselves. The vision evidence cache uses this:
     * its lifetime is the `visionCacheTtl` setting, which must not be capped
     * by whatever TTL this cache object happened to be built with.
     */
    getWithAge(key) {
      return entries.get(key)
    },
    get(key) {
      const hit = entries.get(key)
      if (hit === undefined) return undefined
      // ttlMs <= 0 means "do not expire on its own" — the caller decides.
      if (ttlMs > 0 && Date.now() - hit.at > ttlMs) {
        entries.delete(key)
        return undefined
      }
      return hit.value
    },
    set(key, value) {
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value)
      entries.set(key, { value, at: Date.now() })
    },
  }
}

/** Extract the latest user message from a request's message array. */
export function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message && message.role === 'user' && Array.isArray(message.content)) return message
  }
  return undefined
}

/**
 * Rough token cost of one text block.
 *
 * There is no tokenizer on this path, so this splits the character stream into
 * CJK/fullwidth (≈1 token each) and everything else (≈3.5 chars per token,
 * which is conservative for code and English prose). Over-estimating only
 * costs a needlessly skipped route; under-estimating sends a request a model
 * cannot hold, so the bias is intentional.
 *
 * @param {string} text
 * @returns {number} estimated tokens (may be fractional)
 */
export function textTokens(text) {
  const value = String(text ?? '')
  let wide = 0
  for (const ch of value) {
    if (ch >= '\u2e80') wide += 1 // CJK ideographs, kana, hangul, fullwidth forms
  }
  return wide + (value.length - wide) / 3.5
}

/** Estimated token cost of a whole message array (text blocks + image blocks). */
export function estimatePromptTokens(messages, options = {}) {
  const perImage = Number.isFinite(options.perImageTokens) ? options.perImageTokens : 800

  /**
   * Cost of one block, recursing into nested payloads.
   *
   * Recursion is the point: a `tool-result` block carries its output in a
   * NESTED content array, and tool output is usually the bulk of a long
   * coding session. Counting it as a flat allowance under-estimated a
   * realistic history by more than an order of magnitude, which defeated the
   * context guard exactly where it matters (a big history aimed at a
   * small-window model).
   */
  const blockTokens = (block) => {
    if (block === null || typeof block !== 'object') return 0
    if (block.type === 'text' && typeof block.text === 'string') return textTokens(block.text)
    if (block.type === 'image') return perImage
    let nested = 0
    if (Array.isArray(block.content)) {
      for (const inner of block.content) nested += blockTokens(inner)
    }
    // Tool-call arguments are real prompt content too (the model receives them).
    if (block.arguments !== undefined) {
      const raw = typeof block.arguments === 'string'
        ? block.arguments
        : (() => { try { return JSON.stringify(block.arguments) ?? '' } catch { return '' } })()
      nested += textTokens(raw)
    }
    // Unknown block kinds keep a flat allowance so they are never free.
    return nested > 0 ? nested : 64
  }

  let total = 0
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      total += blockTokens(block)
    }
    // Role framing, tool-call metadata and the like.
    total += 8
  }
  return Math.ceil(total)
}

/** Join the text blocks of a message content array. */
export function blocksText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Stable cache key for one classification input. */
export function cacheKeyFor(text) {
  return String(text ?? '').slice(0, 120)
}

/** Error finish chunk in the DSH stream vocabulary (mirrors adapterFailureChunk). */
export function failureChunk(message, code = 'TRANSPORT', signal) {
  const failure = { message, code }
  return {
    type: 'finish',
    reason: signal && signal.aborted
      ? { kind: 'aborted', failure }
      : { kind: 'error', failure },
  }
}

/** The virtual router adapter. */
export class TierRouterAdapter extends LlmAdapter {
  constructor(ctx, getSettings, options = {}) {
    super()
    this.ctx = ctx
    this.getSettings = getSettings
    this.stats = options.stats ?? createStats()
    this.cache = options.cache ?? createDecisionCache()
    // Evidence cache for the vision sidecar, keyed by attachment id. Built
    // with no TTL of its own: the `visionCacheTtl` setting governs the
    // lifetime (see lib/vision.js), so a setting above one hour is no longer
    // silently capped at one hour. maxEntries still bounds memory.
    this.visionCache = options.visionCache ?? createDecisionCache(0, 200)
    // Context windows per provider/model. Model metadata is effectively static
    // for a session, so a plain Map beats re-resolving on every request.
    this.contextWindows = new Map()
    this.log = options.log ?? ((...args) => ctx.logger?.info?.(...args))
  }

  /**
   * Known context window for one route, or undefined when the provider does
   * not report one (unknown must never block routing — only a *known* window
   * that is too small does).
   */
  async contextWindowOf(provider, model) {
    const key = `${provider}/${model}`
    const hit = this.contextWindows.get(key)
    const now = Date.now()
    // A known window is stable for the process; an UNKNOWN one is only trusted
    // briefly (see CONTEXT_WINDOW_RETRY_MS) so a transient metadata failure
    // cannot disable the guard for the whole session.
    if (hit !== undefined && (hit.window !== undefined || now - hit.at < CONTEXT_WINDOW_RETRY_MS)) {
      return hit.window
    }
    let window
    try {
      const info = await this.ctx.llm.resolveModelInfo(provider, model)
      const value = info?.context?.contextWindow
      if (Number.isFinite(value) && value > 0) window = value
    } catch { /* metadata unavailable → unknown */ }
    this.contextWindows.set(key, { window, at: now })
    return window
  }

  // Display strings are deliberately locale-neutral English: they surface in
  // the host-side model picker, which has no access to the client locale. The
  // settings card supplies its own localized labels.
  providerInfo(provider) {
    return { id: provider, name: 'Tier Router' }
  }

  listModels(provider) {
    return Promise.resolve([
      {
        provider,
        id: MODEL,
        name: 'Tier Router (auto)',
        description: 'Routes by difficulty (hard / normal / easy) and by vision need; configure the tiers in Settings → Tier Router',
        inputModalities: ['text', 'image'],
      },
    ])
  }

  resolveModel(provider, model, _signal) {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Tier Router (auto)',
      description: 'Routes by difficulty (hard / normal / easy) and by vision need',
      inputModalities: ['text', 'image'],
      // The chat input selector exposes only Off / On (High):
      //   Off → reasoning disabled for ALL tiers (master switch)
      //   On  → per-tier effort from Settings → Tier Router takes effect
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off', description: 'No extended reasoning' },
          { id: 'high', name: 'High', description: 'High reasoning effort' },
        ],
        defaultEffort: 'off',
      },
    })
  }

  /** Resolved settings (schema defaults + entry base + user section). */
  config() {
    return this.getSettings() ?? DEFAULTS
  }

  /** Build the ordered delegation chain for one request. */
  async resolveChain(options) {
    const settings = this.config()
    const messages = options.messages ?? []
    const last = lastUserMessage(messages)
    const text = last === undefined ? '' : blocksText(last.content)
    // The request carries the FULL conversation history, so a session that
    // ever received an image keeps image blocks in every later request.
    // Routing must treat that as a vision request too: a text-only tier model
    // would otherwise reject the whole history ("does not support image
    // input"), which is exactly the failure seen when a text message follows
    // an earlier image in the same session.
    const hasImage = Array.isArray(messages) && messages.some(
      (message) => Array.isArray(message?.content) && contentHasImage(message.content),
    )

    if (!settings.enabled) return { kind: 'disabled', hasImage }

    // Where the routing time goes, surfaced per decision in the card. The
    // phases here run BEFORE the chosen model is called, so they are pure
    // router overhead — the part that reads as "the router is slow".
    const timings = { classifyMs: 0, guardMs: 0 }

    // How big is this request? Models with a *known* smaller window are
    // skipped below: sending a 180k-token history to a 131k-token model burns
    // a round trip and fails with a provider error.
    const estimate = estimatePromptTokens(messages)
    const guarded = settings.contextGuard !== false

    const defaultRoute = normalizeRoute(
      routeConfigured(fallbackRoute(settings))
        ? fallbackRoute(settings)
        : this.sessionDefaultRoute(),
    )
    /** Never route back into the router itself (would recurse forever). */
    const pushIfRoutable = (route, reason) => {
      const normalized = normalizeRoute(route)
      if (!routeConfigured(normalized)) return
      if (normalized.provider === PROVIDER) return
      if (chain.some((c) => c.provider === normalized.provider && c.model === normalized.model)) return
      chain.push({ ...normalized, reason })
    }
    const chain = []
    /**
     * Drop routes whose known context window cannot hold the estimate.
     * Unknown windows always pass. If every route would be dropped, the
     * original chain is returned untouched: the guard must never turn a
     * routable request into "no route". The skip list is kept in that case
     * too, so a request that fails anyway still explains itself in the card
     * instead of showing an unexplained provider error.
     */
    const guard = async (routes) => {
      if (!guarded || routes.length === 0) return { chain: routes, skipped: [] }
      const guardStartedAt = Date.now()
      const kept = []
      const skipped = []
      for (const route of routes) {
        const window = await this.contextWindowOf(route.provider, route.model)
        if (window !== undefined && window * CONTEXT_HEADROOM < estimate) {
          skipped.push({ provider: route.provider, model: route.model, window, reason: route.reason })
          continue
        }
        kept.push(route)
      }
      if (kept.length === 0) return { chain: routes, skipped }
      timings.guardMs = Date.now() - guardStartedAt
      return { chain: kept, skipped }
    }

    if (hasImage) {
      // vision: configured vision tier → explicit vision fallbacks → default
      pushIfRoutable(tierRoute(settings, 'vision'), 'vision tier')
      for (const fb of Array.isArray(settings.visionFallbacks) ? settings.visionFallbacks : []) {
        pushIfRoutable(fb, 'vision fallback')
      }
      pushIfRoutable(defaultRoute, 'default model')
      const vision = await guard(chain)
      return {
        kind: 'vision', level: 'vision', chain: vision.chain, text, hasImage,
        estimate, skipped: vision.skipped, timings,
      }
    }

    // text: classify difficulty → tier chain → default
    let level = 'normal'
    let cause = 'no text'
    if (text !== '') {
      if (String(settings.classifier) === 'llm') {
        // classifyWithLlm is async: awaiting here is what makes the LLM
        // classifier's level actually reach the chain (a missed await used to
        // leave `level` undefined and silently route every request to the
        // hard tier). It is bounded, so a slow classifier degrades to the
        // heuristic instead of stalling the request.
        const startedAt = Date.now()
        const llm = await this.classifyWithLlm(text, options.signal)
        timings.classifyMs = Date.now() - startedAt
        if (llm !== undefined) {
          level = llm.level
          cause = llm.reason || 'llm classifier'
        } else {
          const heuristic = classifyDifficulty(text)
          level = heuristic.level
          cause = timings.classifyMs >= (Number(settings.classifierTimeoutMs) || CLASSIFIER_TIMEOUT_MS)
            ? `llm classifier too slow (${timings.classifyMs}ms) → heuristic`
            : 'llm classifier unavailable → heuristic'
        }
      } else {
        const heuristic = classifyDifficulty(text)
        level = heuristic.level
        cause = heuristic.reasons.join('; ')
      }
    }

    const requested = normalizeRoute(tierRoute(settings, level))
    pushIfRoutable(requested, `${level} tier`)
    for (const tier of TIER_ORDER) {
      if (tier === level) continue
      pushIfRoutable(tierRoute(settings, tier), `${tier} tier (fallback)`)
    }
    pushIfRoutable(defaultRoute, 'default model')
    const guardedChain = await guard(chain)
    return {
      kind: 'text', level, cause, chain: guardedChain.chain, text, hasImage,
      estimate, skipped: guardedChain.skipped, timings,
    }
  }

  /** The session default model, when it is not the router itself. */
  sessionDefaultRoute() {
    try {
      const service = this.ctx.get?.('agentDefaultModel')
      const selection = service?.currentSelection?.()
      if (selection && selection.provider && selection.provider !== PROVIDER) {
        return { provider: selection.provider, model: selection.model, effort: '' }
      }
    } catch { /* service absent */ }
    return { provider: '', model: '', effort: '' }
  }

  /**
   * LLM classification, cached; falls back to undefined (caller → heuristic).
   *
   * Bounded by `classifierTimeoutMs`: classification sits on the critical path
   * *before* the real request is sent, and a local classifier can take many
   * seconds — or a minute when its model is cold. On timeout the request
   * proceeds on the heuristic immediately while the classifier keeps running,
   * so its answer still lands in the cache and the next request is fast.
   */
  async classifyWithLlm(text, signal, timeoutMs) {
    const settings = this.config()
    const route = classifierRoute(settings)
    if (route === undefined) return undefined
    const key = cacheKeyFor(text)
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached

    const classify = async () => {
      const prepared = await this.ctx.llm.prepareCall(
        { provider: route.provider, model: route.model, maxTokens: 200 },
        signal,
      )
      let raw = ''
      // Config fields must mirror prepared.config exactly (the target adapter
      // may materialize a default reasoningEffort, which `callConfigEquals`
      // would otherwise reject with INVALID_PREPARED_CALL).
      const forwarded = {
        provider: prepared.config.provider,
        model: prepared.config.model,
        messages: [
          {
            role: 'system',
            content: [{ type: 'text', text: CLASSIFIER_SYSTEM_PROMPT }],
            source: { kind: 'plugin', plugin: 'dsh-tier-router' },
          },
          {
            role: 'user',
            content: [{ type: 'text', text: classifierUserPrompt(text) }],
            source: { kind: 'plugin', plugin: 'dsh-tier-router' },
          },
        ],
        ...(prepared.config.reasoningEffort === undefined ? {} : { reasoningEffort: prepared.config.reasoningEffort }),
        ...(prepared.config.maxTokens === undefined ? {} : { maxTokens: prepared.config.maxTokens }),
        signal,
      }
      for await (const chunk of prepared.stream(forwarded)) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
      }
      const parsed = parseClassifierReply(raw)
      if (parsed !== undefined) this.cache.set(key, parsed)
      return parsed
    }

    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : Number(this.config().classifierTimeoutMs) || CLASSIFIER_TIMEOUT_MS
    // The rejection handler is attached to the promise we race, so a late
    // failure after a timeout is not an unhandled rejection.
    const running = classify().catch((error) => {
      this.log(`tier-router: llm classifier failed (${route.provider}/${route.model}): ${String(error)}`)
      return undefined
    })
    const timedOut = await raceTimeout(running, budget)
    if (timedOut === TIMED_OUT) {
      this.log(`tier-router: llm classifier exceeded ${budget}ms → heuristic (its answer is cached when it arrives)`)
      return undefined
    }
    return timedOut
  }

  /** The router stream: classify → delegate along the chain. */
  async *stream(options) {
    const settings = this.config()
    // Everything before the chosen model is called is router overhead: this is
    // the number that reads as "the router is slow", so it is measured and
    // reported per decision.
    const routeStartedAt = Date.now()
    const prepareStartedAt = Date.now()
    const routedOptions = await this.prepareMessages(options, settings)
    const prepareMs = Date.now() - prepareStartedAt
    const resolveStartedAt = Date.now()
    const resolved = await this.resolveChain(routedOptions)
    const resolveMs = Date.now() - resolveStartedAt
    const timings = {
      prepareMs,
      resolveMs,
      classifyMs: Number(resolved.timings?.classifyMs) || 0,
      guardMs: Number(resolved.timings?.guardMs) || 0,
      overheadMs: Date.now() - routeStartedAt,
    }
    const decidedKind = resolved.hasImage ? 'vision' : 'text'
    const decidedLevel = String(resolved.level ?? '')
    // Models passed over because their context window could not hold the
    // request — the answer to "why did it not use my normal tier?".
    const skipped = Array.isArray(resolved.skipped)
      ? resolved.skipped.map((s) => `${s.provider}/${s.model} (${s.window} < est ${resolved.estimate}, ${s.reason})`)
      : []
    const estimate = Number.isFinite(resolved.estimate) ? resolved.estimate : 0
    let kind = resolved.kind
    if (resolved.kind === 'disabled') {
      const pass = this.sessionDefaultRoute()
      if (routeConfigured(pass)) {
        // Visible like any other decision: the card should show where a
        // disabled router sent the request, not just that it sent it.
        this.stats.recordDecision({
          kind: decidedKind,
          level: decidedLevel,
          provider: pass.provider,
          model: pass.model,
          reason: 'router disabled → session default',
          estimate,
          skipped,
          timings,
        })
        yield* this.delegate(routedOptions, { ...pass, reason: 'router disabled → default' })
        return
      }
      kind = 'error'
    }

    if (kind === 'error' || resolved.chain.length === 0) {
      this.stats.record('error')
      const message = resolved.kind === 'disabled'
        ? 'tier-router: disabled and no default model configured; pick a model in Settings → Tier Router or the model selector'
        : `tier-router: no model configured for ${resolved.level ?? 'this request'}; configure tiers in Settings → Tier Router`
      this.stats.recordDecision({
        kind: decidedKind,
        level: decidedLevel,
        outcome: 'failed',
        reason: resolved.kind === 'disabled' ? 'disabled, no default model' : 'no route configured',
        estimate,
        skipped,
      })
      yield failureChunk(message, 'NO_ROUTE', options.signal)
      return
    }

    if (resolved.hasImage) this.stats.record('vision')
    else if (resolved.level) this.stats.record(resolved.level)

    const tried = []
    // The route the classification actually asked for; anything else answering
    // is a fallback, which is what the `fallback` counter reports.
    const requestedTarget = resolved.chain[0]
    let lastError
    for (const target of resolved.chain) {
      try {
        this.log(`tier-router: ${resolved.hasImage ? 'vision' : resolved.level ?? 'text'} → ${target.provider}/${target.model} (${target.reason})`)
        yield* this.delegate(routedOptions, target)
        if (target !== requestedTarget) this.stats.record('fallback')
        this.stats.recordDecision({
          kind: decidedKind,
          level: decidedLevel,
          provider: target.provider,
          model: target.model,
          effort: target.effort,
          reason: target.reason,
          tried,
          estimate,
          skipped,
          timings,
        })
        return
      } catch (error) {
        lastError = error
        tried.push(`${target.provider}/${target.model}`)
        // Chunk-level failures are already recorded inside delegate (they
        // carry `routeFailure`); only record prepare-time throws here.
        if (!error?.routeFailure) {
          this.stats.recordError(`${target.provider}/${target.model}`, String(error))
        }
        this.log(`tier-router: route ${target.provider}/${target.model} failed: ${String(error)}`)
      }
    }
    this.stats.record('error')
    this.stats.recordDecision({
      kind: decidedKind,
      level: decidedLevel,
      outcome: 'failed',
      reason: `every route failed (${tried.join(', ')})`,
      tried,
      estimate,
      skipped,
      timings,
    })
    yield failureChunk(
      `tier-router: every route failed (${resolved.chain.map((t) => `${t.provider}/${t.model}`).join(', ')}): ${String(lastError)}`,
      'ROUTE_FAILED',
      options.signal,
    )
  }

  /**
   * Apply the vision sidecar: in `replace` mode (default), split every image
   * block out of the conversation, have the vision model return structured
   * evidence, and put that text back where the image was — the turn then
   * flows through the difficulty tiers like any text request. In `route`
   * mode the old behavior is kept: the whole request goes to the vision tier.
   */
  async prepareMessages(options, settings) {
    const hasImage = messagesHaveImage(options.messages)
    if (!hasImage || String(settings.visionMode ?? 'replace') === 'route') return options
    const messages = await replaceImages(
      this.ctx,
      settings,
      options.messages,
      options.signal,
      this.visionCache,
      this.stats,
      this.log,
    )
    return { ...options, messages }
  }

  /**
   * Delegate one request to a concrete provider/model via the prepared-call
   * contract.
   *
   * The forwarded request's config fields MUST equal the config the adapter
   * resolved during `prepareCall` (provider/model/reasoningEffort/maxTokens/
   * temperature/stop are compared by `callConfigEquals`; a mismatch throws
   * `INVALID_PREPARED_CALL`). The original request may carry a maxTokens or a
   * reasoningEffort from the smart-model seat, and the target adapter may
   * materialize its own defaults — so the forwarded config is rebuilt from
   * `prepared.config` instead of copied from `options`.
   */
  async *delegate(options, target) {
    const { reasoningEffort: chatEffort, maxTokens: _mt, temperature: _t, stop: _s, ...rest } = options
    // Reasoning effort two-tier hierarchy:
    //   Chat input selector is the master switch:
    //     'off' / '' / undefined → reasoning disabled for ALL tiers
    //     'high' / 'max' / any non-empty → per-tier setting from this page takes effect
    //   Per-tier effort (hardEffort / normalEffort / easyEffort) is the
    //     actual value when the chat switch is "on" (non-empty, non-off).
    const chatWantsReasoning = chatEffort !== '' && chatEffort !== undefined && chatEffort !== 'off'
    const tierEffort = target.effort
    const config = {
      provider: target.provider,
      model: target.model,
      ...(chatWantsReasoning && tierEffort !== '' ? { reasoningEffort: tierEffort } : {}),
    }
    const prepared = await this.ctx.llm.prepareCall(config, options.signal)
    const forwarded = {
      ...rest,
      provider: prepared.config.provider,
      model: prepared.config.model,
      ...(prepared.config.reasoningEffort === undefined ? {} : { reasoningEffort: prepared.config.reasoningEffort }),
      ...(prepared.config.maxTokens === undefined ? {} : { maxTokens: prepared.config.maxTokens }),
      ...(prepared.config.temperature === undefined ? {} : { temperature: prepared.config.temperature }),
      ...(prepared.config.stop === undefined ? {} : { stop: prepared.config.stop }),
    }
    // Terminal error chunks from the delegated adapter do NOT throw (the LLM
    // runtime converts them into finish/error chunks), so the chain fallback
    // can never catch them. When the adapter fails BEFORE producing any
    // output, convert the failure into a throw so the chain tries the next
    // route; once content has been produced, pass chunks through untouched
    // (falling back mid-stream would duplicate partial output).
    //
    // `produced` tracks CONTENT, not "any chunk seen": adapters emit
    // structural chunks (`block-start`, `usage`, …) before their first delta,
    // and treating those as output silently disabled the fallback chain for
    // any adapter that fails after opening a block but before filling it.
    let produced = false
    for await (const chunk of prepared.stream(forwarded)) {
      if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        this.stats.recordError(
          `${target.provider}/${target.model}`,
          chunk.reason.failure?.message ?? 'delegated stream failed',
        )
        if (!produced) {
          const failure = chunk.reason.failure
          throw Object.assign(
            new Error(`route ${target.provider}/${target.model} failed before any output: ${failure?.message ?? 'unknown'}`),
            { routeFailure: failure },
          )
        }
      }
      if (CONTENT_CHUNK_TYPES.has(chunk?.type)) produced = true
      yield chunk
    }
  }
}

