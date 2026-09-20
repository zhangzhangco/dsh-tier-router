import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TierRouterAdapter, createDecisionCache, createStats, estimatePromptTokens, lastUserMessage,
  lastUserMessageIndex, lastUserText, isToolResultMessage, isHumanMessage, turnKeyFor, fingerprintOf,
  failureCodeOf, failureMessageOf,
  blocksText, failureChunk,
} from '../lib/router.js'
import { DEFAULTS } from '../lib/schema.js'

/**
 * A settings object with every route blank, so each test states exactly which
 * tiers it configures. Tests must not silently depend on the shipped defaults:
 * those are deliberately pre-pointed at the author's routes, and a test that
 * leans on them breaks the moment a user retargets a tier.
 */
function settings(overrides = {}) {
  return {
    ...DEFAULTS,
    hardProvider: '', hardModel: '', hardEffort: '',
    normalProvider: '', normalModel: '', normalEffort: '',
    easyProvider: '', easyModel: '', easyEffort: '',
    visionProvider: '', visionModel: '', visionEffort: '',
    visionFallbacks: [],
    fallbackProvider: '', fallbackModel: '',
    ...overrides,
  }
}

/** A fake ctx exposing just what resolveChain touches. */
function fakeCtx(defaultSelection) {
  const service = defaultSelection === undefined
    ? undefined
    : { currentSelection: () => defaultSelection }
  return {
    get: (name) => (name === 'agentDefaultModel' ? service : undefined),
    llm: {
      prepareCall: async () => { throw new Error('unused') },
    },
  }
}

function adapter(overrides, defaultSelection) {
  const router = new TierRouterAdapter(fakeCtx(defaultSelection), () => settings(overrides))
  return router
}

/** Build a stream options object with a last user message. */
function optionsFor(text, { withImage = false } = {}) {
  const content = withImage
    ? [
        { type: 'text', text },
        { type: 'image', attachment: { id: 'sha256:abc', mediaType: 'image/png' } },
      ]
    : [{ type: 'text', text }]
  return {
    provider: 'tier-router',
    model: 'smart',
    messages: [
      { role: 'user', content, source: { kind: 'user' } },
    ],
    signal: undefined,
  }
}

// ---------- resolveChain: vision ----------

test('resolveChain: an image request with a configured vision tier routes to it', async () => {
  const router = adapter({
    visionProvider: 'zhipu-vision',
    visionModel: 'glm-4v-flash',
    easyProvider: 'deepseek-official',
    easyModel: 'deepseek-chat',
  })
  const resolved = await router.resolveChain(optionsFor('看看这张图', { withImage: true }))
  assert.equal(resolved.kind, 'vision')
  assert.equal(resolved.hasImage, true)
  assert.equal(resolved.chain[0].provider, 'zhipu-vision')
  assert.equal(resolved.chain[0].model, 'glm-4v-flash')
})

test('resolveChain: vision tier → explicit vision fallbacks → session default, in order', async () => {
  const router = adapter({
    visionProvider: 'ovh-vision',
    visionModel: 'Qwen2.5-VL-72B-Instruct',
    visionFallbacks: [{ provider: 'zhipu-vision', model: 'glm-4v-flash' }],
  }, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  const resolved = await router.resolveChain(optionsFor('看图', { withImage: true }))
  assert.deepEqual(resolved.chain.map((c) => `${c.provider}/${c.model}`), [
    'ovh-vision/Qwen2.5-VL-72B-Instruct',
    'zhipu-vision/glm-4v-flash',
    'deepseek-official/deepseek-v4-pro',
  ])
})

test('resolveChain: a history image (not just the last message) routes to the vision tier', async () => {
  const router = adapter({
    visionProvider: 'ovh-vision',
    visionModel: 'Qwen2.5-VL-72B-Instruct',
  })
  const options = {
    provider: 'tier-router',
    model: 'smart',
    messages: [
      { role: 'user', content: [{ type: 'image', attachment: { id: 'sha256:old', mediaType: 'image/png' } }], source: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model' } },
      { role: 'user', content: [{ type: 'text', text: '继续说' }], source: { kind: 'user' } },
    ],
    signal: undefined,
  }
  const resolved = await router.resolveChain(options)
  assert.equal(resolved.hasImage, true)
  assert.equal(resolved.kind, 'vision')
  assert.equal(resolved.chain[0].provider, 'ovh-vision')
})

test('resolveChain: pure-text sessions stay on the difficulty tiers', async () => {
  const router = adapter({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
    normalProvider: 'deepseek-official',
    normalModel: 'deepseek-chat',
  })
  const resolved = await router.resolveChain(optionsFor('修复这个 bug'))
  assert.equal(resolved.hasImage, false)
  assert.equal(resolved.kind, 'text')
  assert.equal(resolved.level, 'normal')
})

// ---------- resolveChain: difficulty ladder ----------

test('resolveChain: hard classification picks the hard tier, normal tier second in the ladder', async () => {
  const router = adapter({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
    normalProvider: 'deepseek-official',
    normalModel: 'deepseek-chat',
  })
  const resolved = await router.resolveChain(optionsFor('重构整个 service 层，涉及 a.ts b.ts c.ts 三处架构调整'))
  assert.equal(resolved.level, 'hard')
  assert.equal(resolved.chain[0].provider, 'deepseek-official')
  assert.equal(resolved.chain[0].model, 'deepseek-v4-pro')
  // ladder: normal tier second
  assert.equal(resolved.chain[1].model, 'deepseek-chat')
})

test('resolveChain: an unconfigured requested tier falls through to the configured tier, then the default', async () => {
  const router = adapter(
    { easyProvider: 'deepseek-official', easyModel: 'deepseek-chat' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  )
  const resolved = await router.resolveChain(optionsFor('修复这个 bug'))
  assert.equal(resolved.level, 'normal')
  assert.deepEqual(resolved.chain.map((c) => c.model), ['deepseek-chat', 'deepseek-v4-pro'])
})

test('resolveChain: with no tiers configured, the session default is the only route', async () => {
  const router = adapter({}, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  const resolved = await router.resolveChain(optionsFor('你好'))
  assert.equal(resolved.chain.length, 1)
  assert.equal(resolved.chain[0].provider, 'deepseek-official')
  assert.equal(resolved.chain[0].model, 'deepseek-v4-pro')
})

test('resolveChain: the shipped defaults form a complete ladder with no configuration at all', async () => {
  // Regression guard for the base layer: DEFAULTS carries the concrete tiers,
  // so a fresh install routes somewhere instead of falling straight through.
  const router = new TierRouterAdapter(fakeCtx(undefined), () => ({ ...DEFAULTS }))
  const resolved = await router.resolveChain(optionsFor('帮我看看这个函数'))
  assert.equal(resolved.kind, 'text')
  assert.ok(resolved.chain.length >= 1)
  assert.equal(resolved.chain[0].provider, DEFAULTS[`${resolved.level}Provider`])
  assert.equal(resolved.chain[0].model, DEFAULTS[`${resolved.level}Model`])
})

test('resolveChain: duplicate routes are deduplicated', async () => {
  const router = adapter({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
    normalProvider: 'deepseek-official',
    normalModel: 'deepseek-v4-pro',
  })
  const resolved = await router.resolveChain(optionsFor('修复这个 bug'))
  const keys = resolved.chain.map((c) => `${c.provider}/${c.model}`)
  assert.equal(new Set(keys).size, keys.length)
})

test('resolveChain: disabled reports kind disabled', async () => {
  const router = adapter({ enabled: false })
  const resolved = await router.resolveChain(optionsFor('hi'))
  assert.equal(resolved.kind, 'disabled')
})

// ---------- resolveChain: recursion guard ----------

test('resolveChain: a tier pointing at the router itself is skipped', async () => {
  const router = adapter({
    hardProvider: 'tier-router',
    hardModel: 'smart',
    normalProvider: 'deepseek-official',
    normalModel: 'deepseek-chat',
  })
  const resolved = await router.resolveChain(optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整'))
  assert.ok(resolved.chain.every((c) => c.provider !== 'tier-router'))
  assert.equal(resolved.chain[0].provider, 'deepseek-official')
  assert.equal(resolved.chain[0].model, 'deepseek-chat')
})

test('resolveChain: vision tier and vision fallbacks pointing at the router fall through to the default', async () => {
  const router = adapter({
    visionProvider: 'tier-router',
    visionModel: 'smart',
    visionFallbacks: [{ provider: 'tier-router', model: 'smart' }],
  }, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  const resolved = await router.resolveChain(optionsFor('看图', { withImage: true }))
  assert.ok(resolved.chain.every((c) => c.provider !== 'tier-router'))
  assert.equal(resolved.chain.length, 1)
  assert.equal(resolved.chain[0].model, 'deepseek-v4-pro')
})

test('resolveChain: a session default that is the router itself yields an empty chain', async () => {
  const router = adapter({}, { provider: 'tier-router', model: 'smart' })
  const resolved = await router.resolveChain(optionsFor('hi'))
  assert.equal(resolved.chain.length, 0)
  assert.equal(resolved.kind, 'text')
})

// ---------- helpers ----------

test('lastUserMessage / blocksText: the last user message wins, empties are safe', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } },
  ]
  assert.equal(blocksText(lastUserMessage(messages).content), 'second')
  assert.equal(lastUserMessage([]), undefined)
  assert.equal(lastUserMessage(undefined), undefined)
})

test('failureChunk: shape mirrors the adapter error finish chunk', () => {
  const chunk = failureChunk('boom', 'NO_ROUTE')
  assert.equal(chunk.type, 'finish')
  assert.equal(chunk.reason.kind, 'error')
  assert.equal(chunk.reason.failure.code, 'NO_ROUTE')
  assert.equal(chunk.reason.failure.message, 'boom')
})

// ---------- stats ----------

test('stats: record counts only known kinds', () => {
  const stats = createStats()
  stats.record('hard')
  stats.record('vision')
  stats.record('error')
  const snapshot = stats.snapshot()
  assert.equal(snapshot.hard, 1)
  assert.equal(snapshot.vision, 1)
  assert.equal(snapshot.error, 1)
  assert.equal(snapshot.normal, 0)
})

test('stats: recordError keeps a bounded ring of recent failures', () => {
  const stats = createStats()
  for (let i = 0; i < 12; i += 1) stats.recordError(`p${i}/m${i}`, `err ${i}`)
  const snapshot = stats.snapshot()
  assert.equal(snapshot.errors.length, 8)
  assert.equal(snapshot.errors[0].target, 'p4/m4') // oldest kept
  assert.equal(snapshot.errors[7].target, 'p11/m11') // newest
  assert.ok(snapshot.errors[0].at)
})

// ---------- stream() integration with a fake llm service ----------

/**
 * A fake llm service recording prepareCall configs and streaming chunks back.
 * `defaultsByKey` simulates adapters that materialize a default
 * reasoningEffort/maxTokens during prepareCall. The prepared stream mimics
 * the real `callConfigEquals` guard: a forwarded request whose config fields
 * differ from the resolved config throws INVALID_PREPARED_CALL, exactly like
 * dsh-llm does.
 */
function fakeLlm(streamsByKey, failPrepare = [], defaultsByKey = {}) {
  const calls = []
  const llm = {
    calls,
    async prepareCall(config, signal) {
      calls.push({ config, signal })
      const key = `${config.provider}/${config.model}`
      if (failPrepare.includes(key)) throw new Error(`prepare ${key} failed`)
      const defaults = defaultsByKey[key] ?? {}
      const resolvedConfig = {
        provider: config.provider,
        model: config.model,
        ...(config.reasoningEffort !== undefined
          ? { reasoningEffort: config.reasoningEffort }
          : defaults.reasoningEffort !== undefined
            ? { reasoningEffort: defaults.reasoningEffort }
            : {}),
        ...(config.maxTokens !== undefined
          ? { maxTokens: config.maxTokens }
          : defaults.maxTokens !== undefined
            ? { maxTokens: defaults.maxTokens }
            : {}),
      }
      const chunks = streamsByKey[key] ?? [{ type: 'text-delta', index: 0, text: '?' }]
      // A stream whose first chunk is an error finish has no output prefix —
      // mimics an adapter failing before producing anything.
      const noPrefix = chunks[0]?.type === 'finish' && chunks[0]?.reason?.kind === 'error'
      return {
        config: resolvedConfig,
        async *stream(forwarded) {
          const eq = (a, b) => a.provider === b.provider && a.model === b.model &&
            a.reasoningEffort === b.reasoningEffort && a.maxTokens === b.maxTokens
          if (!eq(forwarded, resolvedConfig)) {
            throw new Error('INVALID_PREPARED_CALL: prepared LLM call config changed before adapter dispatch')
          }
          if (!noPrefix) yield { type: 'text-delta', index: 0, text: `[${forwarded.provider}/${forwarded.model}]` }
          for (const chunk of chunks) yield chunk
        },
      }
    },
  }
  return llm
}

function collect(stream) {
  return (async () => {
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
  })()
}

test('stream: delegates a text request to the classified tier and passes chunks through', async () => {
  const llm = fakeLlm({ 'deepseek-official/deepseek-v4-pro': [] })
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
  }))
  const chunks = await collect(router.stream(optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整')))
  assert.equal(llm.calls.length, 1)
  assert.deepEqual(llm.calls[0].config, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.equal(chunks[0].type, 'text-delta')
  assert.equal(chunks[0].text, '[deepseek-official/deepseek-v4-pro]')
})

test('stream: the chat reasoning switch off keeps every tier effort-free', async () => {
  const llm = fakeLlm({ 'deepseek-official/deepseek-v4-pro': [] })
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
    hardEffort: 'max',
  }))
  const options = optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整')
  options.reasoningEffort = 'off' // master switch off → no reasoning anywhere
  await collect(router.stream(options))
  assert.deepEqual(llm.calls[0].config, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
})

test('stream: strips inherited reasoningEffort and applies the tier effort', async () => {
  const llm = fakeLlm({ 'deepseek-official/deepseek-v4-pro': [] })
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
    hardEffort: 'max',
  }))
  const options = optionsFor('重构')
  options.reasoningEffort = 'high' // inherited from the smart model selection
  await collect(router.stream(options))
  assert.deepEqual(llm.calls[0].config, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
  })
})

test('stream: visionMode route — an image request delegates to the vision tier (legacy)', async () => {
  const llm = fakeLlm({ 'ovh-vision/Qwen2.5-VL-72B-Instruct': [] })
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    visionMode: 'route',
    visionProvider: 'ovh-vision',
    visionModel: 'Qwen2.5-VL-72B-Instruct',
  }))
  await collect(router.stream(optionsFor('看图', { withImage: true })))
  assert.equal(llm.calls.length, 1)
  assert.deepEqual(llm.calls[0].config, {
    provider: 'ovh-vision',
    model: 'Qwen2.5-VL-72B-Instruct',
  })
})

test('stream: visionMode replace (default) — the image is analyzed, then difficulty routes', async () => {
  // The vision sidecar asks the vision model for structured evidence; the
  // turn then flows through the difficulty tiers like a text request.
  const llm = fakeLlm({
    'ovh-vision/Qwen2.5-VL-72B-Instruct': [
      { type: 'text-delta', index: 0, text: '{"summary":"a cat","ocr":{"full_text":"MEOW","lines":[]},"layout":{"regions":[]},"semantics":{"scene":"cat","entities":[]},"visual":{"dominant_colors":[]},"uncertainty":[]}' },
    ],
    'deepseek-official/deepseek-chat': [],
  })
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    visionProvider: 'ovh-vision',
    visionModel: 'Qwen2.5-VL-72B-Instruct',
    normalProvider: 'deepseek-official',
    normalModel: 'deepseek-chat',
  }))
  const chunks = await collect(router.stream(optionsFor('看图', { withImage: true })))
  // first call = vision analysis; second call = the difficulty-tier model
  assert.equal(llm.calls.length, 2)
  assert.equal(llm.calls[0].config.provider, 'ovh-vision')
  assert.equal(llm.calls[1].config.provider, 'deepseek-official')
  assert.equal(chunks[0].text, '[deepseek-official/deepseek-chat]')
})

test('stream: falls back to the next route when prepareCall fails', async () => {
  const llm = fakeLlm(
    { 'deepseek-official/deepseek-chat': [] },
    ['deepseek-official/deepseek-v4-pro'],
  )
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
    normalProvider: 'deepseek-official',
    normalModel: 'deepseek-chat',
  }))
  const chunks = await collect(router.stream(optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整')))
  assert.equal(llm.calls.length, 2)
  assert.equal(chunks[0].text, '[deepseek-official/deepseek-chat]')
})

test('stream: all routes failing yields an error finish chunk (never hangs)', async () => {
  const llm = fakeLlm({}, ['deepseek-official/deepseek-v4-pro'])
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
  }))
  const chunks = await collect(router.stream(optionsFor('重构 service 层')))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'ROUTE_FAILED')
})

test('stream: no route configured at all yields a NO_ROUTE error chunk', async () => {
  const llm = fakeLlm({})
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({}))
  const chunks = await collect(router.stream(optionsFor('帮我重构一下')))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.failure.code, 'NO_ROUTE')
})

test('stream: disabled passes through to the session default', async () => {
  const llm = fakeLlm({ 'deepseek-official/deepseek-v4-pro': [] })
  const ctx = {
    get: (name) => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }) }
      : undefined),
    llm,
    logger: { info: () => {} },
  }
  const router = new TierRouterAdapter(ctx, () => settings({ enabled: false }))
  const chunks = await collect(router.stream(optionsFor('hi')))
  assert.equal(llm.calls.length, 1)
  assert.deepEqual(llm.calls[0].config, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.equal(chunks[0].text, '[deepseek-official/deepseek-v4-pro]')
})

test('stream: inherited maxTokens is not forwarded; prepared defaults are mirrored (no INVALID_PREPARED_CALL)', async () => {
  // The smart seat may carry maxTokens/reasoningEffort, and the target
  // adapter may materialize its own defaults — the forwarded request must
  // mirror prepared.config exactly.
  const llm = fakeLlm(
    { 'deepseek-official/deepseek-v4-pro': [] },
    [],
    { 'deepseek-official/deepseek-v4-pro': { reasoningEffort: 'high', maxTokens: 8192 } },
  )
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
  }))
  const options = optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整')
  options.maxTokens = 4096 // inherited from the smart model seat
  options.reasoningEffort = 'off' // inherited too
  const chunks = await collect(router.stream(options))
  assert.equal(chunks[0].text, '[deepseek-official/deepseek-v4-pro]')
  // prepareCall config stays minimal (no inherited maxTokens/effort)
  assert.deepEqual(llm.calls[0].config, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
})

test('stream: tier effort overrides inherited effort and passes the prepared guard', async () => {
  const llm = fakeLlm(
    { 'deepseek-official/deepseek-v4-pro': [] },
    [],
    { 'deepseek-official/deepseek-v4-pro': { maxTokens: 8192 } },
  )
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
    hardEffort: 'max',
  }))
  const options = optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整')
  options.reasoningEffort = 'high' // inherited; tier effort must win
  const chunks = await collect(router.stream(options))
  assert.equal(chunks[0].text, '[deepseek-official/deepseek-v4-pro]')
  assert.deepEqual(llm.calls[0].config, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
  })
})

test('stream: the llm classifier uses prepared.config fields (adapter default effort tolerated)', async () => {
  const llm = fakeLlm(
    { 'deepseek-official/deepseek-chat': [{ type: 'text-delta', index: 0, text: '{"level": "hard", "reason": "refactor"}' }] },
    [],
    { 'deepseek-official/deepseek-chat': { reasoningEffort: 'high' } },
  )
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    classifier: 'llm',
    easyProvider: 'deepseek-official',
    easyModel: 'deepseek-chat',
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
  }))
  const chunks = await collect(router.stream(optionsFor('随便聊两句')))
  // classifier call succeeded (no INVALID_PREPARED_CALL) and routed to hard
  assert.equal(llm.calls.length, 2)
  assert.equal(chunks[0].text, '[deepseek-official/deepseek-v4-pro]')
})

test('stream: terminal error chunks after output are passed through and recorded', async () => {
  const errorChunk = {
    type: 'finish',
    reason: { kind: 'error', failure: { code: 'QUOTA', message: 'provider quota exceeded' } },
  }
  // prefix chunk first: the adapter produced output, so the error passes
  // through (no fallback) instead of throwing
  const llm = fakeLlm({ 'deepseek-official/deepseek-v4-pro': [
    { type: 'text-delta', index: 0, text: 'partial' },
    errorChunk,
  ] })
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
  }), { stats })
  const chunks = await collect(router.stream(optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整')))
  // the error chunk passes through unchanged
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.failure.code, 'QUOTA')
  // and it lands in the stats ring for the settings card
  assert.equal(stats.snapshot().errors.length, 1)
  assert.equal(stats.snapshot().errors[0].target, 'deepseek-official/deepseek-v4-pro')
  assert.match(stats.snapshot().errors[0].message, /quota exceeded/)
})

test('stream: an adapter failing before any output falls back to the next route', async () => {
  const errorChunk = {
    type: 'finish',
    reason: { kind: 'error', failure: { code: 'QUOTA', message: 'quota exceeded' } },
  }
  const llm = fakeLlm({
    'deepseek-official/deepseek-v4-pro': [errorChunk],
    'deepseek-official/deepseek-chat': [],
  })
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
    normalProvider: 'deepseek-official',
    normalModel: 'deepseek-chat',
  }), { stats })
  const chunks = await collect(router.stream(optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整')))
  // first route failed before output → chain moved to the normal tier
  assert.equal(chunks[0].text, '[deepseek-official/deepseek-chat]')
  assert.equal(llm.calls.length, 2)
  assert.equal(stats.snapshot().errors.length, 1)
  assert.equal(stats.snapshot().errors[0].target, 'deepseek-official/deepseek-v4-pro')
})

// ---------- context guard: a small-window model must not be handed a long session ----------

test('estimatePromptTokens: CJK counts heavier than Latin, images add a fixed cost', () => {
  assert.equal(estimatePromptTokens([]), 0)
  const latin = estimatePromptTokens([{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(350) }] }])
  const cjk = estimatePromptTokens([{ role: 'user', content: [{ type: 'text', text: '好'.repeat(350) }] }])
  assert.ok(latin < 200, `350 Latin chars should stay well under 200 tokens, got ${latin}`)
  assert.ok(cjk > 300, `350 CJK chars should approach 1 token each, got ${cjk}`)
  const withImage = estimatePromptTokens([{ role: 'user', content: [{ type: 'image', attachment: { id: 'x' } }] }])
  assert.ok(withImage >= 800, 'an image block costs a fixed allowance')
})

test('resolveChain: a route whose known window is too small is skipped', async () => {
  const windows = { 'small/model': 1000, 'big/model': 200000, 'tier-router/smart': undefined }
  const ctx = {
    get: () => undefined,
    llm: {
      prepareCall: async () => { throw new Error('unused') },
      resolveModelInfo: async (provider, model) => {
        const window = windows[`${provider}/${model}`]
        return window === undefined ? {} : { context: { contextWindow: window } }
      },
    },
  }
  const router = new TierRouterAdapter(ctx, () => settings({
    easyProvider: 'small', easyModel: 'model',
    normalProvider: 'big', normalModel: 'model',
  }))
  // A long body pushes the estimate past the small model's window.
  const resolved = await router.resolveChain(optionsFor('请帮我重构这段代码 '.repeat(400)))
  const targets = resolved.chain.map((c) => `${c.provider}/${c.model}`)
  assert.ok(!targets.includes('small/model'), `small model must be skipped, got ${targets.join(',')}`)
  assert.deepEqual(resolved.skipped.map((s) => `${s.provider}/${s.model}`), ['small/model'])
  assert.ok(resolved.estimate > 1000)
})

test('resolveChain: unknown context windows are never treated as too small', async () => {
  const ctx = {
    get: () => undefined,
    llm: {
      prepareCall: async () => { throw new Error('unused') },
      resolveModelInfo: async () => { throw new Error('no metadata for this provider') },
    },
  }
  const router = new TierRouterAdapter(ctx, () => settings({
    easyProvider: 'mystery', easyModel: 'unknown',
  }))
  const resolved = await router.resolveChain(optionsFor('请帮我重构这段代码 '.repeat(400)))
  assert.deepEqual(resolved.chain.map((c) => `${c.provider}/${c.model}`), ['mystery/unknown'])
  assert.deepEqual(resolved.skipped, [])
})

test('resolveChain: the guard never empties a chain (fail-open)', async () => {
  const ctx = {
    get: () => undefined,
    llm: {
      prepareCall: async () => { throw new Error('unused') },
      resolveModelInfo: async () => ({ context: { contextWindow: 100 } }),
    },
  }
  const router = new TierRouterAdapter(ctx, () => settings({
    easyProvider: 'tiny', easyModel: 'model',
    hardProvider: 'tiny2', hardModel: 'model',
  }))
  const resolved = await router.resolveChain(optionsFor('长文本 '.repeat(500)))
  assert.ok(resolved.chain.length > 0, 'a routable request must never become "no route"')
  // ...and the card still gets to explain the failure.
  assert.equal(resolved.skipped.length, resolved.chain.length)
})

test('resolveChain: contextGuard=false disables the skip entirely', async () => {
  const ctx = {
    get: () => undefined,
    llm: {
      prepareCall: async () => { throw new Error('unused') },
      resolveModelInfo: async () => ({ context: { contextWindow: 100 } }),
    },
  }
  const router = new TierRouterAdapter(ctx, () => settings({
    contextGuard: false,
    easyProvider: 'tiny', easyModel: 'model',
  }))
  const resolved = await router.resolveChain(optionsFor('长文本 '.repeat(500)))
  assert.deepEqual(resolved.chain.map((c) => `${c.provider}/${c.model}`), ['tiny/model'])
  assert.deepEqual(resolved.skipped, [])
})

test('stats: decisions record which model answered, and what was skipped', () => {
  const stats = createStats()
  stats.recordDecision({
    kind: 'text', level: 'normal', provider: 'codex-local', model: 'gpt-5.5',
    reason: 'normal tier', estimate: 181000, skipped: ['gpudev/qwen3.8-27b-q5 (131072 < est 181000, easy tier (fallback))'],
  })
  stats.recordDecision({ kind: 'text', level: 'easy', outcome: 'failed', reason: 'every route failed', tried: ['a/b'] })
  const { decisions } = stats.snapshot()
  assert.equal(decisions.length, 2)
  assert.equal(decisions[0].provider, 'codex-local')
  assert.equal(decisions[0].model, 'gpt-5.5')
  assert.equal(decisions[0].estimate, 181000)
  assert.match(decisions[0].skipped[0], /131072/)
  assert.equal(decisions[1].outcome, 'failed')
  assert.deepEqual(decisions[1].tried, ['a/b'])
})

test('stats: the decision ring is bounded', () => {
  const stats = createStats()
  for (let i = 0; i < 30; i += 1) stats.recordDecision({ provider: `p${i}`, model: `m${i}` })
  const { decisions } = stats.snapshot()
  assert.equal(decisions.length, 20)
  assert.equal(decisions.at(-1).provider, 'p29')
})

// ---------- regression guards for the counter + cache-TTL fixes ----------

test('createDecisionCache: a zero TTL never expires on its own, getWithAge exposes the entry', () => {
  const cache = createDecisionCache(0, 10)
  cache.set('k', 'v')
  // Simulate an old entry: the caller (vision.js) owns the lifetime now.
  const entry = cache.getWithAge('k')
  assert.equal(entry.value, 'v')
  entry.at = Date.now() - 10 * 60 * 60 * 1000
  assert.equal(cache.get('k'), 'v', 'a zero TTL must not evict')
  assert.equal(cache.getWithAge('k').value, 'v')
})

test('createDecisionCache: a positive TTL still expires', () => {
  const cache = createDecisionCache(1000, 10)
  cache.set('k', 'v')
  cache.getWithAge('k').at = Date.now() - 5000
  assert.equal(cache.get('k'), undefined)
  assert.equal(cache.getWithAge('k'), undefined, 'expired entries are dropped by get')
})

test('stream: the fallback counter counts only routes that were not requested', async () => {
  // The classified tier fails, so the second route answers → exactly one fallback.
  const llm = fakeLlm(
    { 'deepseek-official/deepseek-chat': [] },
    ['deepseek-official/deepseek-v4-pro'],
  )
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
    normalProvider: 'deepseek-official',
    normalModel: 'deepseek-chat',
  }), { stats })
  await collect(router.stream(optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整')))
  assert.equal(stats.snapshot().fallback, 1, 'the answering fallback tier must be counted')
})

test('stream: a request answered by its own tier does not count as a fallback', async () => {
  const llm = fakeLlm({ 'deepseek-official/deepseek-v4-pro': [] })
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
  }), { stats })
  await collect(router.stream(optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整')))
  assert.equal(stats.snapshot().fallback, 0)
})

// ---------- review fixes: estimator reach, fallback flag, window retry ----------

test('estimatePromptTokens: counts text nested inside tool-result blocks', () => {
  const payload = 'x'.repeat(14000) // ~4000 tokens
  const nested = [{ role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text: payload }] }] }]
  const flat = [{ role: 'user', content: [{ type: 'text', text: payload }] }]
  // Tool output is usually the bulk of a long coding session; counting it as a
  // flat allowance under-estimated real histories by >10x.
  assert.equal(estimatePromptTokens(nested), estimatePromptTokens(flat))
  assert.ok(estimatePromptTokens(nested) > 3900, 'nested tool output must not be free')
})

test('estimatePromptTokens: counts tool-call arguments', () => {
  const block = { type: 'tool-call', name: 'write', arguments: { path: '/tmp/x', body: 'y'.repeat(7000) } }
  assert.ok(estimatePromptTokens([{ role: 'assistant', content: [block] }]) > 1800)
})

test('estimatePromptTokens: an unknown block kind keeps a flat allowance', () => {
  assert.equal(estimatePromptTokens([{ role: 'user', content: [{ type: 'mystery' }] }]), 72)
})

test('stream: a structural chunk before a yielded error still falls back', async () => {
  // Adapters emit block-start before their first delta. Treating that as
  // "output produced" silently disabled the fallback chain.
  const calls = []
  const llm = {
    async prepareCall(config) {
      calls.push(`${config.provider}/${config.model}`)
      return {
        config: { provider: config.provider, model: config.model },
        async *stream() {
          if (config.model === 'first') {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'TRANSPORT' } } }
            return
          }
          yield { type: 'text-delta', index: 0, text: 'answered by the fallback tier' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'p', hardModel: 'first',
    normalProvider: 'p', normalModel: 'second',
  }), { stats: createStats() })
  const chunks = await collect(router.stream(optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整')))
  assert.deepEqual(calls, ['p/first', 'p/second'], 'the chain must advance past a pre-output failure')
  assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'answered by the fallback tier'))
})

test('stream: a failure after real output does NOT fall back (no duplicated output)', async () => {
  const calls = []
  const llm = {
    async prepareCall(config) {
      calls.push(`${config.provider}/${config.model}`)
      return {
        config: { provider: config.provider, model: config.model },
        async *stream() {
          yield { type: 'text-delta', index: 0, text: 'partial answer' }
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'died mid-stream', code: 'TRANSPORT' } } }
        },
      }
    },
  }
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'p', hardModel: 'first',
    normalProvider: 'p', normalModel: 'second',
  }), { stats: createStats() })
  const chunks = await collect(router.stream(optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整')))
  assert.deepEqual(calls, ['p/first'], 'must not retry after partial output')
  assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'partial answer'))
})

test('contextWindowOf: a transient failure is retried, a known window is not', async () => {
  let attempts = 0
  let window
  const llm = {
    async resolveModelInfo() {
      attempts += 1
      if (window === undefined) throw new Error('provider not ready')
      return { context: { contextWindow: window } }
    },
  }
  const router = new TierRouterAdapter({ get: () => undefined, llm, logger: { info: () => {} } }, () => settings({}))
  assert.equal(await router.contextWindowOf('p', 'm'), undefined)
  assert.equal(await router.contextWindowOf('p', 'm'), undefined)
  assert.equal(attempts, 1, 'an unknown window is cached briefly, not resolved per call')
  // After the retry window lapses the lookup runs again and the guard engages.
  router.contextWindows.get('p/m').at = Date.now() - 120_000
  window = 131_072
  assert.equal(await router.contextWindowOf('p', 'm'), 131_072)
  assert.equal(attempts, 2)
  // A resolved window is stable: no further metadata calls.
  window = 999
  assert.equal(await router.contextWindowOf('p', 'm'), 131_072)
  assert.equal(attempts, 2)
})

// ---------- routing latency: nothing on the critical path may stall ----------

/** An llm whose classifier never answers quickly (models a cold local model). */
function slowClassifierLlm(delayMs, reply = '{"level": "easy", "reason": "slow"}', classifierModel = 'slow-classifier') {
  const calls = []
  const llm = {
    calls,
    async prepareCall(config) {
      calls.push(`${config.provider}/${config.model}`)
      if (config.model === classifierModel) {
        return {
          config: { provider: config.provider, model: config.model, maxTokens: config.maxTokens },
          async *stream() {
            await new Promise((resolve) => setTimeout(resolve, delayMs))
            yield { type: 'text-delta', index: 0, text: reply }
          },
        }
      }
      return {
        config: { provider: config.provider, model: config.model },
        async *stream() {
          yield { type: 'text-delta', index: 0, text: `[${config.provider}/${config.model}]` }
        },
      }
    },
  }
  return llm
}

const CLASSIFIED = '重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整'

test('stream: a slow LLM classifier does not stall the request (bounded, → heuristic)', async () => {
  const llm = slowClassifierLlm(3000, '{"level": "easy", "reason": "slow"}')
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    classifier: 'llm',
    llmClassifierProvider: 'p', llmClassifierModel: 'slow-classifier',
    classifierTimeoutMs: 60,
    hardProvider: 'p', hardModel: 'fast-target',
  }), { stats: createStats() })
  const started = Date.now()
  const chunks = await collect(router.stream(optionsFor(CLASSIFIED)))
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1500, `request must not wait for the classifier (took ${elapsed}ms)`)
  // The heuristic answer for this text is "hard", and the hard tier answered.
  assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === '[p/fast-target]'))
})

test('stream: the late classifier answer is cached for the next request', async () => {
  const llm = slowClassifierLlm(120, '{"level": "easy", "reason": "slow"}')
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    classifier: 'llm',
    llmClassifierProvider: 'p', llmClassifierModel: 'slow-classifier',
    classifierTimeoutMs: 30, // times out, then the answer lands in the cache
    easyProvider: 'p', easyModel: 'easy-target',
    normalProvider: 'p', normalModel: 'normal-target',
    hardProvider: 'p', hardModel: 'hard-target',
  }), { stats })
  await collect(router.stream(optionsFor(CLASSIFIED)))
  assert.equal(
    llm.calls.filter((c) => c === 'p/slow-classifier').length, 1,
    'the classifier was called once (plus the delegated target)',
  )
  await new Promise((resolve) => setTimeout(resolve, 300)) // let the late answer land
  await collect(router.stream(optionsFor(CLASSIFIED)))
  // Second request: cache hit for the classification, and the "easy" verdict
  // the slow classifier returned is what routes the request now.
  assert.equal(llm.calls.filter((c) => c === 'p/slow-classifier').length, 1, 'the classifier must not be called twice')
  const decision = stats.snapshot().decisions.at(-1)
  assert.equal(decision.level, 'easy')
  assert.equal(decision.model, 'easy-target')
})

test('decision records carry where the routing time went', async () => {
  const llm = fakeLlm({ 'deepseek-official/deepseek-v4-pro': [] })
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official', hardModel: 'deepseek-v4-pro',
  }), { stats })
  await collect(router.stream(optionsFor(CLASSIFIED)))
  const decision = stats.snapshot().decisions.at(-1)
  assert.ok(Number.isFinite(decision.timings.overheadMs), 'overheadMs must be recorded')
  assert.ok(decision.timings.overheadMs >= 0)
  // The heuristic path is local work only. Asserting an exact 0 here was really
  // asserting the clock's resolution: classification now serializes the bounded
  // evidence envelope, which costs a fraction of a millisecond and rounds to 1.
  // What matters is that the tier came from the heuristic, not a model call.
  assert.equal(decision.classifier, 'heuristic', 'the heuristic decided, so no classifier was called')
  assert.ok(decision.timings.classifyMs < 50,
    `heuristic classification must stay local (measured ${decision.timings.classifyMs}ms)`)
  assert.ok(Number.isFinite(decision.timings.guardMs))
})

test('settings: the classifier budget defaults to 4s and is overridable', () => {
  assert.equal(DEFAULTS.classifierTimeoutMs, 4000)
  assert.equal(DEFAULTS.visionTimeoutMs, 60000)
})

// ---------- auditability: which denominator, and why this level ----------

test('createStats: recordTurn counts a turn once, whatever the key repeats', () => {
  const stats = createStats()
  assert.equal(stats.recordTurn('s1#0', 'normal', false), true)
  assert.equal(stats.recordTurn('s1#0', 'normal', false), false, 'the same turn must not be counted twice')
  assert.equal(stats.recordTurn('s1#0', 'hard', false), false, 'a re-classification inside the turn is still the same turn')
  assert.equal(stats.recordTurn('s1#2', 'hard', false), true, 'a new user message starts a new turn')
  assert.equal(stats.recordTurn('s2#0', 'easy', false), true, 'another session at the same index is another turn')
  assert.equal(stats.recordTurn(undefined, 'easy', false), false, 'a request with no human message is not a human turn')
  assert.equal(stats.recordTurn(undefined, 'easy', false), false)
  const snapshot = stats.snapshot()
  assert.equal(snapshot.turns.total, 3)
  assert.equal(snapshot.turns.normal, 1)
  assert.equal(snapshot.turns.hard, 1)
  assert.equal(snapshot.turns.easy, 1)
  // The per-request counters are a different denominator and stay untouched.
  assert.equal(snapshot.hard + snapshot.normal + snapshot.easy, 0)
})

test('createStats: a vision turn is counted as a vision turn, not as a level', () => {
  const stats = createStats()
  stats.recordTurn('s1#0', 'normal', true)
  const snapshot = stats.snapshot()
  assert.equal(snapshot.turns.vision, 1)
  assert.equal(snapshot.turns.normal, 0)
  assert.equal(snapshot.normal, 0)
})

test('createStats: snapshot copies the turn counters', () => {
  const stats = createStats()
  const snapshot = stats.snapshot()
  snapshot.turns.total = 99
  assert.equal(stats.snapshot().turns.total, 0, 'mutating a snapshot must not reach the counters')
})

test('createStats: a recovered route failure is no longer reported as zero errors', () => {
  const stats = createStats()
  stats.recordError('p/m', 'boom')
  const snapshot = stats.snapshot()
  // `error` stays reserved for requests nothing could answer...
  assert.equal(snapshot.error, 0)
  // ...but the failure the fallback chain recovered is visible on its own.
  assert.equal(snapshot.routeError, 1)
  assert.equal(snapshot.errors.length, 1)
})

test('fingerprintOf: stable, 8 hex chars, sensitive to content', () => {
  assert.match(fingerprintOf('继续'), /^[0-9a-f]{8}$/)
  assert.equal(fingerprintOf('继续'), fingerprintOf('继续'))
  assert.notEqual(fingerprintOf('继续'), fingerprintOf('继续修复'))
  assert.equal(fingerprintOf(undefined), fingerprintOf(''))
})

test('lastUserMessageIndex / turnKeyFor: index and session identify the turn', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'one' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'tool', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'out' }] }] },
  ]
  // A tool step appends messages but does not move the last user message.
  assert.equal(lastUserMessageIndex(messages), 0)
  assert.equal(turnKeyFor({ messages, sessionId: 's1' }), 's1#0')
  const grown = [...messages, { role: 'assistant', content: [{ type: 'text', text: 'more' }] }]
  assert.equal(turnKeyFor({ messages: grown, sessionId: 's1' }), 's1#0', 'a tool step is the same turn')
  const next = [...grown, { role: 'user', content: [{ type: 'text', text: 'two' }] }]
  assert.equal(turnKeyFor({ messages: next, sessionId: 's1' }), 's1#4', 'a new message is a new turn')
  assert.equal(turnKeyFor({ messages: next, sessionId: 's2' }), 's2#4')
  assert.equal(turnKeyFor({ messages: [] }), undefined)
  assert.equal(turnKeyFor({}), undefined)
  assert.equal(lastUserMessageIndex(undefined), -1)
})

test('recordDecision: carries the diagnosis, with safe defaults and caps', () => {
  const stats = createStats()
  stats.recordDecision({
    level: 'normal', cause: 'x'.repeat(400), classifier: 'heuristic',
    turn: true, fingerprint: 'abcdef0123456789', inputChars: 85.6,
  })
  stats.recordDecision({ level: 'easy' })
  const [full, bare] = stats.snapshot().decisions
  assert.equal(full.cause.length, 240, 'cause is capped before it reaches the card')
  assert.equal(full.classifier, 'heuristic')
  assert.equal(full.turn, true)
  assert.equal(full.fingerprint, 'abcdef0123456789')
  assert.equal(full.inputChars, 86)
  assert.equal(bare.cause, '')
  assert.equal(bare.classifier, '')
  assert.equal(bare.turn, false)
  assert.equal(bare.fingerprint, '')
  assert.equal(bare.inputChars, 0)
})

test('stats: an agent tool loop counts many requests but one human turn', async () => {
  const llm = fakeLlm({ 'deepseek-official/deepseek-chat': [] })
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    normalProvider: 'deepseek-official', normalModel: 'deepseek-chat',
    fallbackProvider: 'deepseek-official', fallbackModel: 'deepseek-chat',
  }), { stats })
  const request = (messages) => ({ provider: 'tier-router', model: 'smart', messages, sessionId: 's1' })
  const first = [{ role: 'user', content: [{ type: 'text', text: '帮我改一下 index.js 里的日志级别' }] }]
  for (let step = 0; step < 4; step += 1) {
    const messages = [...first]
    for (let i = 0; i < step; i += 1) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `step ${i}` }] })
      messages.push({ role: 'tool', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] })
    }
    await collect(router.stream(request(messages)))
  }
  const looped = stats.snapshot()
  assert.equal(looped.normal, 4, 'the per-request counter counts every step')
  assert.equal(looped.turns.total, 1, 'but four steps of one loop are one turn')
  assert.equal(looped.turns.normal, 1)

  // A new user message moves the last-user-message index → a new turn.
  const second = [
    ...first,
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    { role: 'user', content: [{ type: 'text', text: '再改一处' }] },
  ]
  await collect(router.stream(request(second)))
  const after = stats.snapshot()
  assert.equal(after.turns.total, 2)
  assert.equal(after.decisions.at(-1).turn, true, 'the decision marks the turn boundary')
  assert.equal(after.decisions.at(-2).turn, false, 'and a mid-loop step does not')
})

test('stream: the decision says which classifier decided, and whether it was cached', async () => {
  const llm = slowClassifierLlm(0, '{"level": "easy", "reason": "small talk"}', 'fast-classifier')
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    classifier: 'llm',
    llmClassifierProvider: 'p', llmClassifierModel: 'fast-classifier',
    easyProvider: 'p', easyModel: 'easy-target',
    normalProvider: 'p', normalModel: 'normal-target',
  }), { stats })
  await collect(router.stream(optionsFor(CLASSIFIED)))
  const first = stats.snapshot().decisions.at(-1)
  assert.equal(first.classifier, 'llm')
  assert.equal(first.cause, 'small talk', "the classifier's own reason is what the card shows")
  assert.equal(first.turn, true)
  await collect(router.stream(optionsFor(CLASSIFIED)))
  const second = stats.snapshot().decisions.at(-1)
  assert.equal(second.classifier, 'llm-cache')
  assert.equal(second.turn, false, 'the cached repeat is the same turn')
})

test('stream: a timed-out classifier is attributed, not silently absorbed', async () => {
  const llm = slowClassifierLlm(2000, '{"level": "easy", "reason": "slow"}')
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    classifier: 'llm',
    llmClassifierProvider: 'p', llmClassifierModel: 'slow-classifier',
    classifierTimeoutMs: 30,
    hardProvider: 'p', hardModel: 'hard-target',
  }), { stats })
  await collect(router.stream(optionsFor(CLASSIFIED)))
  const decision = stats.snapshot().decisions.at(-1)
  assert.equal(decision.classifier, 'llm-timeout')
  assert.match(decision.cause, /too slow/)
  assert.match(decision.cause, /heuristic/)
  assert.ok(decision.inputChars > 0, 'the heuristic read the whole message')
})

test('stream: an unconfigured classifier is attributed rather than assumed', async () => {
  const llm = fakeLlm({ 'deepseek-official/deepseek-v4-pro': [] })
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    classifier: 'llm', // but no llmClassifier* and no easy tier → no route at all
    hardProvider: 'deepseek-official', hardModel: 'deepseek-v4-pro',
  }), { stats })
  await collect(router.stream(optionsFor(CLASSIFIED)))
  const decision = stats.snapshot().decisions.at(-1)
  assert.equal(decision.classifier, 'llm-unavailable')
  assert.match(decision.cause, /no classifier model configured/)
})

test('stream: the heuristic classifier names itself and its scoring reason', async () => {
  const llm = fakeLlm({ 'deepseek-official/deepseek-v4-pro': [] })
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official', hardModel: 'deepseek-v4-pro',
  }), { stats })
  await collect(router.stream(optionsFor(CLASSIFIED)))
  const decision = stats.snapshot().decisions.at(-1)
  assert.equal(decision.classifier, 'heuristic')
  assert.match(decision.cause, /hard signal/)
  assert.equal(decision.fingerprint, fingerprintOf(CLASSIFIED))
  assert.equal(decision.inputChars, CLASSIFIED.length)
})

test('stream: the decision exposes how little text the classifier actually read', async () => {
  // A request carrying tens of thousands of tokens whose entire classification
  // input is a two-character continuation. That mismatch is the diagnosis, so
  // the card has to be able to show it.
  const llm = fakeLlm({ 'deepseek-official/deepseek-chat': [] })
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    normalProvider: 'deepseek-official', normalModel: 'deepseek-chat',
  }), { stats })
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    { role: 'tool', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'x'.repeat(70000) }] }] },
  ]
  await collect(router.stream({ provider: 'tier-router', model: 'smart', messages, sessionId: 's1' }))
  const decision = stats.snapshot().decisions.at(-1)
  assert.equal(decision.level, 'easy', 'a two-character continuation still scores as easy')
  assert.equal(decision.inputChars, 2, 'the decision reports the two characters it judged')
  assert.ok(decision.estimate > 15000, 'while the request itself carries tens of thousands of tokens')
})

// ---------- tool results are role 'user': never mistake them for the human ----------

/** Messages exactly as dsh-llm declares them (ToolResultMessage.role === 'user'). */
function loopMessages(humanText, steps) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: humanText }], source: { kind: 'user' } }]
  for (let i = 0; i < steps; i += 1) {
    messages.push({ role: 'assistant', content: [{ type: 'tool-call', name: 'read' }], source: { kind: 'model' } })
    messages.push({
      role: 'user',
      content: [{ type: 'tool-result', content: [{ type: 'text', text: `output ${i}` }] }],
      source: { kind: 'tool' },
    })
  }
  return messages
}

test('isToolResultMessage: recognises both the declared source and the block shape', () => {
  assert.equal(isToolResultMessage({ role: 'user', content: [{ type: 'tool-result', content: [] }], source: { kind: 'tool' } }), true)
  // Hand-built requests carry no source, so the block shape has to be enough.
  assert.equal(isToolResultMessage({ role: 'user', content: [{ type: 'tool-result', content: [] }] }), true)
  assert.equal(isToolResultMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), false)
  assert.equal(isToolResultMessage({ role: 'user', content: [] }), false, 'empty content is not a tool result')
  assert.equal(isToolResultMessage(undefined), false)
})

test('lastUserText: a tool result does not hide the human message that produced it', () => {
  const messages = loopMessages('帮我重构 router.js 的并发部分', 3)
  const { text, index } = lastUserText(messages)
  assert.equal(text, '帮我重构 router.js 的并发部分', 'the human text must survive the tool steps')
  assert.equal(index, 0, 'and the turn identity must not move')
  // The bug: the old search returned the tool-result message (role 'user'),
  // whose text is empty, forcing every step to `normal` unclassified.
  assert.equal(lastUserMessage(messages).source.kind, 'user')
})

test('lastUserText: an image-only human message falls back to the nearest earlier text', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '看看这张图' }], source: { kind: 'user' } },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model' } },
    { role: 'user', content: [{ type: 'image', attachment: { id: 'sha256:a' } }], source: { kind: 'user' } },
  ]
  const { text, index } = lastUserText(messages)
  assert.equal(index, 2, 'the newest human message still identifies the turn')
  assert.equal(text, '看看这张图', 'but classification uses the nearest real text')
})

test('lastUserText: a request with only tool results has no turn', () => {
  const orphan = [{ role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'x' }] }], source: { kind: 'tool' } }]
  assert.deepEqual(lastUserText(orphan), { text: '', index: -1 })
  assert.equal(turnKeyFor({ messages: orphan, sessionId: 's1' }), undefined)
})

test('stream: every tool step is classified from the human message, not from empty text', async () => {
  // The regression that mattered: with the old lookup the classifier saw an
  // empty string on every step after the first, so `normal` was not a
  // judgement at all — it was the default value of `level`.
  const llm = fakeLlm({ 'p/hard-target': [] })
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'p', hardModel: 'hard-target',
    normalProvider: 'p', normalModel: 'normal-target',
    fallbackProvider: 'p', fallbackModel: 'normal-target',
  }), { stats })
  const human = '重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整'
  for (let step = 0; step < 3; step += 1) {
    await collect(router.stream({ provider: 'tier-router', model: 'smart', sessionId: 's1', messages: loopMessages(human, step) }))
  }
  const snapshot = stats.snapshot()
  assert.equal(snapshot.hard, 3, 'all three steps must be classified hard, not defaulted to normal')
  assert.equal(snapshot.normal, 0)
  assert.equal(snapshot.turns.total, 1, 'and they are one human turn')
  for (const d of snapshot.decisions) {
    assert.equal(d.classifier, 'heuristic', 'each step ran a real classification')
    assert.equal(d.inputChars, human.length, 'reading the human message, not the tool output')
  }
})

test('stream: a request with no human message is neither classified nor counted as a turn', async () => {
  const llm = fakeLlm({ 'p/normal-target': [] })
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    normalProvider: 'p', normalModel: 'normal-target',
  }), { stats })
  const auxiliary = [{ role: 'system', content: [{ type: 'text', text: 'summarise this session' }], source: { kind: 'plugin' } }]
  await collect(router.stream({ provider: 'tier-router', model: 'smart', sessionId: 's1', messages: auxiliary }))
  const snapshot = stats.snapshot()
  assert.equal(snapshot.turns.total, 0, 'session-title / compaction calls are not human turns')
  assert.equal(snapshot.normal, 0, 'and its default `normal` must not enter the difficulty mix')
  const decision = snapshot.decisions.at(-1)
  assert.equal(decision.turn, false)
  assert.equal(decision.classifier, 'none')
  assert.equal(decision.inputChars, 0)
})

// ---------- route health: "cannot serve" is not "something went wrong once" ----------

/** An llm whose `brokenModel` always fails with the given failure code. */
function failingLlm(brokenModel, code, message) {
  const calls = []
  const llm = {
    calls,
    async prepareCall(config) {
      calls.push(`${config.provider}/${config.model}`)
      const broken = config.model === brokenModel
      return {
        config: { provider: config.provider, model: config.model },
        async *stream() {
          if (broken) {
            yield { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
            return
          }
          yield { type: 'text-delta', index: 0, text: '[fallback]' }
        },
      }
    },
  }
  return llm
}

const HARD_TEXT = '重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整'

test('failureCodeOf / failureMessageOf: prefer the route failure, fall back to the error', () => {
  assert.equal(failureCodeOf({ routeFailure: { code: 'QUOTA', message: 'a' }, code: 'IGNORED' }), 'QUOTA')
  assert.equal(failureCodeOf({ code: 'AUTH' }), 'AUTH')
  assert.equal(failureCodeOf(new Error('plain')), '')
  assert.equal(failureCodeOf(undefined), '')
  assert.equal(failureMessageOf({ routeFailure: { message: 'quota gone' }, message: 'outer' }), 'quota gone')
  assert.equal(failureMessageOf(new Error('outer')), 'outer')
  assert.equal(failureMessageOf(undefined), '')
})

test('route health: a route-level code benches at once, a transient one needs a streak', () => {
  const router = adapter({ routeFailureThreshold: 2, routeCooldownMs: 60_000 })
  router.noteRouteFailure('p', 'm', 'QUOTA', 'usage limit reached')
  assert.equal(router.benchReason('p', 'm').code, 'QUOTA')
  assert.ok(router.benchReason('p', 'm').secondsLeft > 0)

  // A transport blip is not evidence that the route is broken.
  router.noteRouteFailure('q', 'm', 'TRANSPORT', 'socket hang up')
  assert.equal(router.benchReason('q', 'm'), undefined, 'one blip must not bench a route')
  router.noteRouteFailure('q', 'm', 'TRANSPORT', 'socket hang up')
  assert.equal(router.benchReason('q', 'm').code, 'TRANSPORT')
})

test('route health: a success clears the streak, and the bench can be disabled', () => {
  const router = adapter({ routeFailureThreshold: 2, routeCooldownMs: 60_000 })
  router.noteRouteFailure('p', 'm', 'TRANSPORT', 'blip')
  router.noteRouteSuccess('p', 'm')
  router.noteRouteFailure('p', 'm', 'TRANSPORT', 'blip')
  assert.equal(router.benchReason('p', 'm'), undefined, 'the streak restarted after the success')

  const off = adapter({ routeFailureThreshold: 1, routeCooldownMs: 0 })
  off.noteRouteFailure('p', 'm', 'QUOTA', 'usage limit reached')
  assert.equal(off.benchReason('p', 'm'), undefined, 'routeCooldownMs 0 turns the bench off')
})

test('route health: a request-specific failure never benches the route', () => {
  const router = adapter({ routeFailureThreshold: 1, routeCooldownMs: 60_000 })
  for (let i = 0; i < 3; i += 1) router.noteRouteFailure('p', 'm', 'CONTEXT_WINDOW_EXCEEDED', 'too long')
  assert.equal(router.benchReason('p', 'm'), undefined, 'the next, smaller request may well fit')
  router.noteRouteFailure('p', 'm', 'ABORTED', 'user cancelled')
  assert.equal(router.benchReason('p', 'm'), undefined)
})

test('route health: a failure older than the window starts a new streak', () => {
  const router = adapter({ routeFailureThreshold: 2, routeCooldownMs: 60_000 })
  router.noteRouteFailure('p', 'm', 'TRANSPORT', 'yesterday')
  router.routeHealth.get('p/m').at = Date.now() - 10 * 60_000
  router.noteRouteFailure('p', 'm', 'TRANSPORT', 'today')
  assert.equal(router.benchReason('p', 'm'), undefined, 'two failures an hour apart are not a streak')
})

test('stream: an exhausted quota benches the route, so the next request skips it', async () => {
  // The live incident: codex-local's quota is gone, and every request paid the
  // full multi-minute failure before the fallback answered.
  const llm = failingLlm('gpt-6-astra', 'QUOTA', 'codex usage limit reached')
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'codex-local', hardModel: 'gpt-6-astra',
    fallbackProvider: 'deepseek-official', fallbackModel: 'deepseek-chat',
  }), { stats })

  const first = await collect(router.stream(optionsFor(HARD_TEXT)))
  assert.deepEqual(llm.calls, ['codex-local/gpt-6-astra', 'deepseek-official/deepseek-chat'])
  assert.ok(first.some((c) => c.type === 'text-delta' && c.text === '[fallback]'))
  assert.equal(stats.snapshot().routeError, 1)
  assert.equal(stats.snapshot().errors[0].code, 'QUOTA', 'the failure code is kept for the card')

  llm.calls.length = 0
  const second = await collect(router.stream(optionsFor(HARD_TEXT)))
  assert.deepEqual(llm.calls, ['deepseek-official/deepseek-chat'], 'the benched route must not be tried again')
  assert.ok(second.some((c) => c.type === 'text-delta' && c.text === '[fallback]'))
  const decision = stats.snapshot().decisions.at(-1)
  assert.equal(decision.skipped.length, 1)
  assert.match(decision.skipped[0], /gpt-6-astra.*QUOTA.*benched/)
})

test('stream: a transient failure is retried on the next request until it becomes a streak', async () => {
  const llm = failingLlm('gpt-6-astra', 'TRANSPORT', 'socket hang up')
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'codex-local', hardModel: 'gpt-6-astra',
    fallbackProvider: 'deepseek-official', fallbackModel: 'deepseek-chat',
    routeFailureThreshold: 2,
  }), { stats })

  await collect(router.stream(optionsFor(HARD_TEXT)))
  llm.calls.length = 0
  await collect(router.stream(optionsFor(HARD_TEXT)))
  assert.deepEqual(llm.calls, ['codex-local/gpt-6-astra', 'deepseek-official/deepseek-chat'], 'still only a streak of 1')

  llm.calls.length = 0
  await collect(router.stream(optionsFor(HARD_TEXT)))
  assert.deepEqual(llm.calls, ['deepseek-official/deepseek-chat'], 'the third request skips the benched route')
})

test('stream: a benched route never empties the chain (fail open)', async () => {
  // Every route benched: the request must still be attempted rather than
  // turned into a NO_ROUTE error.
  const llm = failingLlm('nothing-matches', 'QUOTA', 'never used')
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'deepseek-official', hardModel: 'deepseek-chat',
  }), { stats })
  router.noteRouteFailure('deepseek-official', 'deepseek-chat', 'QUOTA', 'usage limit reached')
  assert.ok(router.benchReason('deepseek-official', 'deepseek-chat') !== undefined)

  const chunks = await collect(router.stream(optionsFor(HARD_TEXT)))
  assert.deepEqual(llm.calls, ['deepseek-official/deepseek-chat'], 'the only route must still be tried')
  assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === '[fallback]'))
  const decision = stats.snapshot().decisions.at(-1)
  assert.match(decision.skipped.join('; '), /benched/, 'and the card still explains the risk')
})

test('benchedRoutes: lists what is unavailable right now, seconds first', () => {
  const router = adapter({ routeFailureThreshold: 1, routeCooldownMs: 60_000 })
  assert.deepEqual(router.benchedRoutes(), [])
  router.noteRouteFailure('codex-local', 'gpt-6-astra', 'QUOTA', 'codex usage limit reached')
  router.noteRouteFailure('gpudev', 'qwen3.8-27b-q5', 'TRANSPORT', 'endpoint down')
  const benched = router.benchedRoutes()
  assert.equal(benched.length, 2)
  assert.equal(benched[0].provider, 'codex-local')
  assert.equal(benched[0].model, 'gpt-6-astra')
  assert.equal(benched[0].code, 'QUOTA')
  assert.equal(benched[0].message, 'codex usage limit reached')
  assert.ok(benched[0].secondsLeft > 0)
  // An expired bench is not reported.
  router.routeHealth.get('gpudev/qwen3.8-27b-q5').until = Date.now() - 1
  assert.deepEqual(router.benchedRoutes().map((b) => b.provider), ['codex-local'])
})

// ---------- injected context is role 'user' too: only the human message counts ----------

test('isHumanMessage: role "user" alone is not enough', () => {
  // The human, as dsh-client-connection tags it.
  assert.equal(isHumanMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), true)
  // A tool result: role 'user', source 'tool'.
  assert.equal(isHumanMessage({ role: 'user', content: [{ type: 'tool-result', content: [] }], source: { kind: 'tool' } }), false)
  // Plugin-injected context: role 'user', source 'plugin' — the agent loop
  // appends a `snapshot` after every turn.
  assert.equal(isHumanMessage({
    role: 'user',
    content: [{ type: 'text', text: 'AGENT SNAPSHOT …' }],
    source: { kind: 'plugin', plugin: 'agent-loop', form: 'snapshot' },
  }), false)
  assert.equal(isHumanMessage({
    role: 'user',
    content: [{ type: 'text', text: '[model changed: …]' }],
    source: { kind: 'plugin', plugin: 'model-selection', form: 'notice' },
  }), false)
  // Model output is never the human message.
  assert.equal(isHumanMessage({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model' } }), false)
  // Hand-built requests carry no source: structure decides.
  assert.equal(isHumanMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), true)
  assert.equal(isHumanMessage({ role: 'user', content: [{ type: 'tool-result', content: [] }] }), false)
  assert.equal(isHumanMessage(undefined), false)
})

test('lastUserText: injected context after the human message does not hide it', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '给同步脚本加个 --dry-run' }], source: { kind: 'user' } },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model' } },
    {
      role: 'user',
      content: [{ type: 'text', text: `AGENT SNAPSHOT\n${'x'.repeat(3000)}` }],
      source: { kind: 'plugin', plugin: 'agent-loop', form: 'snapshot', sections: [] },
    },
  ]
  const { text, index } = lastUserText(messages)
  assert.equal(text, '给同步脚本加个 --dry-run')
  assert.equal(index, 0)
})

test('stream: the tier comes from the human message, not from the injected snapshot', async () => {
  // The live symptom: the LLM classifier answered "No explicit request text is
  // shown", because it had been handed the agent-loop snapshot that the loop
  // appends after the human message.
  const llm = fakeLlm({ 'p/hard-target': [] })
  const stats = createStats()
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => settings({
    hardProvider: 'p', hardModel: 'hard-target',
    normalProvider: 'p', normalModel: 'normal-target',
  }), { stats })
  const human = '重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整'
  const messages = [
    { role: 'user', content: [{ type: 'text', text: human }], source: { kind: 'user' } },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'read' }], source: { kind: 'model' } },
    { role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'out' }] }], source: { kind: 'tool' } },
    {
      role: 'user',
      content: [{ type: 'text', text: 'AGENT SNAPSHOT: 还有一个未完成的计划，包含若干步骤……'.repeat(40) }],
      source: { kind: 'plugin', plugin: 'agent-loop', form: 'snapshot', sections: [] },
    },
  ]
  await collect(router.stream({ provider: 'tier-router', model: 'smart', sessionId: 's1', messages }))
  const snapshot = stats.snapshot()
  assert.equal(snapshot.hard, 1, 'the snapshot must not downgrade a hard request')
  assert.equal(snapshot.normal, 0)
  const decision = snapshot.decisions.at(-1)
  assert.equal(decision.classifier, 'heuristic')
  assert.equal(decision.inputChars, human.length, 'classified from the human text, not the snapshot')
  assert.equal(snapshot.turns.total, 1)
})

test('lastUserText: a session with only injected context has no human turn', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'prompt' }], source: { kind: 'plugin', plugin: 'x' } },
    { role: 'user', content: [{ type: 'text', text: 'AGENT SNAPSHOT …' }], source: { kind: 'plugin', plugin: 'agent-loop', form: 'snapshot' } },
  ]
  assert.deepEqual(lastUserText(messages), { text: '', index: -1 })
  assert.equal(turnKeyFor({ messages, sessionId: 's1' }), undefined)
})

test('state-aware LLM reclassifies after tools; model changes cannot reuse old cache', async () => {
  const calls = []
  let classifierModel = 'classifier-a'
  const ctx = { llm: { prepareCall: async config => ({ config, async *stream(options) {
    calls.push(options)
    yield { type: 'text-delta', text: '{"level":"hard","reason":"step evidence"}' }
  } }) } }
  const router = new TierRouterAdapter(ctx, () => settings({ classifier: 'llm',
    llmClassifierProvider: 'p', llmClassifierModel: classifierModel, hardProvider: 'p', hardModel: 'hard' }))
  const options = optionsFor('修')
  await router.resolveChain(options)
  await router.resolveChain(options)
  assert.equal(calls.length, 1)
  options.messages.push({ role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'test', arguments: '{}' }] },
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'c1', isError: true,
      content: [{ type: 'text', text: 'cache race failure' }] }] })
  await router.resolveChain(options)
  assert.equal(calls.length, 2)
  assert.match(calls[1].messages[1].content[0].text, /cache race failure/)
  classifierModel = 'classifier-b'
  await router.resolveChain(options)
  assert.equal(calls.length, 3)
})


test('classifier cannot recursively select the virtual router', async () => {
  const router = new TierRouterAdapter(fakeCtx(), () => settings({ classifier: 'llm',
    llmClassifierProvider: 'tier-router', llmClassifierModel: 'smart' }))
  assert.equal((await router.classifyWithLlm('hi')).source, 'unavailable')
})

test('partial output failure is recorded as failed and never retried', async () => {
  const llm = fakeLlm({ 'p/first': [
    { type: 'text-delta', text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'lost' } } },
  ] })
  const stats = createStats()
  const router = new TierRouterAdapter({ llm }, () => settings({ normalProvider: 'p', normalModel: 'first',
    fallbackProvider: 'p', fallbackModel: 'second' }), { stats })
  await collect(router.stream(optionsFor('a request')))
  assert.equal(llm.calls.length, 1)
  assert.equal(stats.snapshot().decisions.at(-1).outcome, 'failed')
  assert.equal(stats.snapshot().error, 1)
})

test('cancelled classification never dispatches the main model', async () => {
  const controller = new AbortController()
  let calls = 0
  const ctx = { llm: { prepareCall: async config => {
    calls++
    return { config, async *stream() { controller.abort(); yield { type: 'text-delta', text: '{"level":"hard"}' } } }
  } } }
  const router = new TierRouterAdapter(ctx, () => settings({ classifier: 'llm',
    llmClassifierProvider: 'p', llmClassifierModel: 'judge', hardProvider: 'p', hardModel: 'main' }))
  const chunks = await collect(router.stream({ ...optionsFor('修'), signal: controller.signal }))
  assert.equal(calls, 1)
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
})


test('disabled router also records a partially failed default stream accurately', async () => {
  const llm = fakeLlm({ 'p/default': [
    { type: 'text-delta', text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'lost' } } },
  ] })
  const stats = createStats()
  const router = new TierRouterAdapter({ llm,
    get: () => ({ currentSelection: () => ({ provider: 'p', model: 'default' }) }),
  }, () => settings({ enabled: false }), { stats })
  await collect(router.stream(optionsFor('hello')))
  assert.equal(stats.snapshot().decisions.at(-1).outcome, 'failed')
})
