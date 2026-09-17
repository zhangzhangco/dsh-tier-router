import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installModelsApi } from '../lib/models-api.js'
import { DEFAULTS } from '../lib/schema.js'
import { TierRouterAdapter, createStats } from '../lib/router.js'

/** Drain a router stream (these tests only care about the side effects). */
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/**
 * Every route blank, so a test states exactly which tiers it configures and
 * never leans on the shipped defaults (those point at the author's own routes).
 */
function routerSettings(overrides = {}) {
  return {
    ...DEFAULTS,
    hardProvider: '', hardModel: '', hardEffort: '',
    normalProvider: '', normalModel: '', normalEffort: '',
    easyProvider: '', easyModel: '', easyEffort: '',
    visionProvider: '', visionModel: '', visionEffort: '',
    visionFallbacks: [],
    fallbackProvider: '', fallbackModel: '',
    classifier: 'heuristic',
    ...overrides,
  }
}

/** Minimal Node http req/res fakes for the webServer handler. */
function fakeReq(method, path, body, headers = {}) {
  return {
    method,
    url: path,
    // The write route requires a JSON content type and a same-origin Host;
    // individual tests override these to exercise the rejections.
    headers: { 'content-type': 'application/json', host: '127.0.0.1:3080', ...headers },
    on(event, cb) {
      if (event === 'data' && body !== undefined) {
        const buf = Buffer.from(JSON.stringify(body), 'utf8')
        queueMicrotask(() => cb(buf))
        return this
      }
      if (event === 'end') {
        queueMicrotask(() => cb())
        return this
      }
      if (event === 'error') return this
      return this
    },
    destroy() {},
  }
}

function fakeRes() {
  const state = { status: 200, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
      return this
    },
    end(text) {
      state.body = text
    },
  }
}

/** Fake settings service: section + recorded mutations. */
function fakeSettings(initialSection = {}) {
  const section = structuredClone(initialSection)
  const writes = []
  return {
    section,
    writes,
    writable: true,
    get(ns) {
      assert.equal(ns, 'tier-router')
      return { ...DEFAULTS, ...section }
    },
    async update(ns, patch) {
      assert.equal(ns, 'tier-router')
      writes.push({ kind: 'update', patch })
      Object.assign(section, patch)
    },
    async mutate(ns, ops) {
      assert.equal(ns, 'tier-router')
      writes.push({ kind: 'mutate', ops })
      for (const op of ops) {
        if (op.op === 'unset') delete section[op.path[0]]
      }
    },
  }
}

/** Invoke the handler and return the response state. */
async function invoke(handler, req, res) {
  await handler(req, res)
  return { ...res.state, json: res.state.body === '' ? undefined : JSON.parse(res.state.body) }
}

test('config GET returns resolved section with defaults', async () => {
  const settings = fakeSettings({ hardProvider: 'deepseek-official' })
  const ctx = { get: (name) => (name === 'settings' ? settings : undefined), llm: { listProviders: () => [], listConfigurableProviders: () => [] } }
  const captured = {}
  ctx.webServer = { register: ({ handler }) => { captured.handler = handler; return () => {} } }
  installModelsApi(ctx, () => ({ snapshot: () => ({}) }))
  const res = await invoke(captured.handler, fakeReq('GET', '/tier-router/api/config'), fakeRes())
  assert.equal(res.status, 200)
  assert.equal(res.json.config.hardProvider, 'deepseek-official')
  assert.equal(res.json.config.enabled, true)
  assert.ok(res.json.defaults)
  assert.equal(res.json.writable, true)
})

test('config POST writes a whitelisted field via settings.update', async () => {
  const settings = fakeSettings()
  const ctx = { get: (name) => (name === 'settings' ? settings : undefined), llm: { listProviders: () => [], listConfigurableProviders: () => [] } }
  const captured = {}
  ctx.webServer = { register: ({ handler }) => { captured.handler = handler; return () => {} } }
  installModelsApi(ctx, () => ({ snapshot: () => ({}) }))

  const res = await invoke(captured.handler, fakeReq('POST', '/tier-router/api/config', { field: 'hardProvider', value: 'deepseek-official' }), fakeRes())
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.config.hardProvider, 'deepseek-official')
  assert.deepEqual(settings.writes[0], { kind: 'update', patch: { hardProvider: 'deepseek-official' } })
})

test('config POST with null value unsets the field', async () => {
  const settings = fakeSettings({ hardProvider: 'deepseek-official', hardModel: 'deepseek-v4-pro' })
  const ctx = { get: (name) => (name === 'settings' ? settings : undefined), llm: { listProviders: () => [], listConfigurableProviders: () => [] } }
  const captured = {}
  ctx.webServer = { register: ({ handler }) => { captured.handler = handler; return () => {} } }
  installModelsApi(ctx, () => ({ snapshot: () => ({}) }))

  const res = await invoke(captured.handler, fakeReq('POST', '/tier-router/api/config', { field: 'hardProvider', value: null }), fakeRes())
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(settings.section.hardProvider, undefined)
  assert.equal(settings.section.hardModel, 'deepseek-v4-pro')
  assert.deepEqual(settings.writes[0], { kind: 'mutate', ops: [{ op: 'unset', path: ['hardProvider'] }] })
})

test('config POST rejects unknown fields', async () => {
  const settings = fakeSettings()
  const ctx = { get: (name) => (name === 'settings' ? settings : undefined), llm: { listProviders: () => [], listConfigurableProviders: () => [] } }
  const captured = {}
  ctx.webServer = { register: ({ handler }) => { captured.handler = handler; return () => {} } }
  installModelsApi(ctx, () => ({ snapshot: () => ({}) }))

  const res = await invoke(captured.handler, fakeReq('POST', '/tier-router/api/config', { field: 'evilField', value: 'x' }), fakeRes())
  assert.equal(res.status, 400)
  assert.match(res.json.error, /unknown config field/)
  assert.equal(settings.writes.length, 0)
})

test('config POST surfaces settings validation failures', async () => {
  const settings = fakeSettings()
  settings.update = async () => { throw new Error('schema rejected: not a string') }
  const ctx = { get: (name) => (name === 'settings' ? settings : undefined), llm: { listProviders: () => [], listConfigurableProviders: () => [] } }
  const captured = {}
  ctx.webServer = { register: ({ handler }) => { captured.handler = handler; return () => {} } }
  installModelsApi(ctx, () => ({ snapshot: () => ({}) }))

  const res = await invoke(captured.handler, fakeReq('POST', '/tier-router/api/config', { field: 'hardProvider', value: 42 }), fakeRes())
  assert.equal(res.status, 400)
  assert.match(res.json.error, /config rejected/)
})

// ---------- vision-tier capability guard ----------

/** Settings service plus an llm stub with configurable resolveModelInfo. */
function visionCtx(settings, inputModalities) {
  const llm = {
    listProviders: () => [],
    listConfigurableProviders: () => [],
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      inputModalities,
    }),
  }
  const ctx = { get: (name) => (name === 'settings' ? settings : undefined), llm }
  const captured = {}
  ctx.webServer = { register: ({ handler }) => { captured.handler = handler; return () => {} } }
  installModelsApi(ctx, () => ({ snapshot: () => ({}) }))
  return { captured, settings }
}

test('config POST rejects a text-only model as the vision tier', async () => {
  const { captured, settings } = visionCtx(
    fakeSettings({ visionProvider: 'deepseek-official' }),
    ['text'], // explicitly no image
  )
  const res = await invoke(
    captured.handler,
    fakeReq('POST', '/tier-router/api/config', { field: 'visionModel', value: 'deepseek-v4-pro' }),
    fakeRes(),
  )
  assert.equal(res.status, 400)
  assert.match(res.json.error, /does not accept image input/)
  assert.equal(settings.writes.length, 0)
})

test('config POST allows vision-capable models in the vision tier', async () => {
  const { captured, settings } = visionCtx(
    fakeSettings({ visionProvider: 'ovh-vision' }),
    ['text', 'image'],
  )
  const res = await invoke(
    captured.handler,
    fakeReq('POST', '/tier-router/api/config', { field: 'visionModel', value: 'Qwen2.5-VL-72B-Instruct' }),
    fakeRes(),
  )
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(settings.writes.length, 1)
})

test('config POST allows unknown-capability models in the vision tier', async () => {
  const { captured, settings } = visionCtx(
    fakeSettings({ visionProvider: 'some-provider' }),
    undefined, // no metadata → unknown
  )
  const res = await invoke(
    captured.handler,
    fakeReq('POST', '/tier-router/api/config', { field: 'visionModel', value: 'mystery-model' }),
    fakeRes(),
  )
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(settings.writes.length, 1)
})

// ---------- the write route must not be CSRF-able ----------

test('config POST rejects a non-JSON content type (a CORS "simple" request)', async () => {
  const settings = fakeSettings({ easyProvider: 'gpudev', easyModel: 'qwen3.8-27b-q5' })
  const { captured } = visionCtx(settings, ['text', 'image'])
  const res = await invoke(
    captured.handler,
    fakeReq('POST', '/tier-router/api/config', { field: 'easyModel', value: 'attacker-model' }, { 'content-type': 'text/plain' }),
    fakeRes(),
  )
  assert.equal(res.status, 415)
  assert.equal(settings.writes.length, 0, 'a text/plain write must never reach settings')
})

test('config POST rejects a cross-origin request even with a JSON content type', async () => {
  const settings = fakeSettings({ easyProvider: 'gpudev', easyModel: 'qwen3.8-27b-q5' })
  const { captured } = visionCtx(settings, ['text', 'image'])
  const res = await invoke(
    captured.handler,
    fakeReq('POST', '/tier-router/api/config', { field: 'easyModel', value: 'attacker-model' }, { origin: 'https://evil.example' }),
    fakeRes(),
  )
  assert.equal(res.status, 403)
  assert.equal(settings.writes.length, 0)
})

test("config POST still accepts the settings card's own same-origin request", async () => {
  const settings = fakeSettings({ easyProvider: 'gpudev', easyModel: 'qwen3.8-27b-q5' })
  const { captured } = visionCtx(settings, ['text', 'image'])
  const res = await invoke(
    captured.handler,
    fakeReq('POST', '/tier-router/api/config', { field: 'easyModel', value: 'qwen3.8-27b-q5' }, { origin: 'http://127.0.0.1:3080' }),
    fakeRes(),
  )
  assert.equal(res.status, 200)
  assert.equal(settings.writes.length, 1)
})

// ---------- the stats endpoint carries the diagnosis, not just the counters ----------

test('stats GET exposes the per-turn counters and the classification diagnosis', async () => {
  // Exercised end to end: a real adapter feeds a real createStats(), the
  // endpoint serialises it. The point of 0.2.2 is that this payload can answer
  // "why was this tier chosen, and on which denominator", so the contract is
  // asserted at the HTTP boundary rather than only on the internal object.
  const stats = createStats()
  const calls = []
  const llm = {
    async prepareCall(config) {
      calls.push(`${config.provider}/${config.model}`)
      return {
        config: { provider: config.provider, model: config.model },
        async *stream() {
          yield { type: 'text-delta', index: 0, text: `[${config.provider}/${config.model}]` }
        },
      }
    },
  }
  const ctx = {
    get: () => undefined,
    llm,
    logger: { info: () => {} },
  }
  const router = new TierRouterAdapter(ctx, () => routerSettings({
    normalProvider: 'deepseek-official', normalModel: 'deepseek-chat',
    fallbackProvider: 'deepseek-official', fallbackModel: 'deepseek-chat',
  }), { stats })

  const first = [{ role: 'user', content: [{ type: 'text', text: '帮我改一下 index.js 里的日志级别' }] }]
  await collect(router.stream({ provider: 'tier-router', model: 'smart', messages: first, sessionId: 's1' }))
  await collect(router.stream({
    provider: 'tier-router',
    model: 'smart',
    sessionId: 's1',
    messages: [...first, { role: 'assistant', content: [{ type: 'text', text: 'step' }] }],
  }))
  const second = [
    ...first,
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    { role: 'user', content: [{ type: 'text', text: '再把 README 补一下' }] },
  ]
  await collect(router.stream({ provider: 'tier-router', model: 'smart', messages: second, sessionId: 's1' }))

  const captured = {}
  ctx.webServer = { register: ({ handler }) => { captured.handler = handler; return () => {} } }
  installModelsApi(ctx, () => stats)
  const res = await invoke(captured.handler, fakeReq('GET', '/tier-router/api/stats'), fakeRes())

  assert.equal(res.status, 200)
  const payload = res.json.stats
  // Per-request vs per-turn are both present and genuinely differ: three
  // requests, two turns.
  assert.equal(payload.normal, 3)
  assert.equal(payload.turns.total, 2)
  assert.equal(payload.turns.normal, 2)
  assert.equal(payload.routeError, 0)

  const last = payload.decisions.at(-1)
  assert.equal(last.classifier, 'heuristic')
  assert.match(last.cause, /score|signal/, 'the scoring reason must survive serialisation')
  assert.equal(last.turn, true, 'the follow-up message opened a new turn')
  assert.match(last.fingerprint, /^[0-9a-f]{8}$/)
  assert.ok(last.inputChars > 0)
})

test('stats GET reports a recovered route failure without calling the request an error', async () => {
  const stats = createStats()
  const llm = {
    async prepareCall(config) {
      const failing = config.model === 'broken'
      return {
        config: { provider: config.provider, model: config.model },
        async *stream() {
          if (failing) {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'TRANSPORT' } } }
            return
          }
          yield { type: 'text-delta', index: 0, text: 'answered by the fallback' }
        },
      }
    },
  }
  const ctx = { get: () => undefined, llm, logger: { info: () => {} } }
  const router = new TierRouterAdapter(ctx, () => routerSettings({
    normalProvider: 'p', normalModel: 'broken',
    fallbackProvider: 'p', fallbackModel: 'deepseek-chat',
  }), { stats })
  await collect(router.stream({
    provider: 'tier-router',
    model: 'smart',
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我改一下 index.js 里的日志级别' }] }],
  }))

  const captured = {}
  ctx.webServer = { register: ({ handler }) => { captured.handler = handler; return () => {} } }
  installModelsApi(ctx, () => stats)
  const res = await invoke(captured.handler, fakeReq('GET', '/tier-router/api/stats'), fakeRes())

  const payload = res.json.stats
  assert.equal(payload.error, 0, 'the request was answered, so it is not an unrecovered error')
  assert.equal(payload.routeError, 1, 'but the failure itself must be visible')
  assert.equal(payload.errors.length, 1)
  assert.equal(payload.fallback, 1)
})
