import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TierRouterAdapter, createDecisionCache, createStats, estimatePromptTokens, lastUserMessage,
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
