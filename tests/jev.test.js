import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  JEV_DEFAULT_MODEL, JEV_QUESTION_ID, JEV_TIER_OPTIONS,
  buildJevRequest, formatJevProbabilities, jevEndpoint, jevIdentity, parseJevReply,
  requestJevTier, resetJevKeyFileCache, resolveJevKey,
} from '../lib/jev.js'
import { TierRouterAdapter, createStats } from '../lib/router.js'
import { DEFAULTS } from '../lib/schema.js'

// ---------- helpers ----------

/** A System One response body carrying one tier answer. */
function reply(level, { confidence = 0.9, probabilities, model = 'jev-1.13.0' } = {}) {
  return {
    model,
    answers: {
      [JEV_QUESTION_ID]: {
        type: 'choice',
        choice: level,
        confidence,
        probabilities: probabilities ?? {
          hard: level === 'hard' ? 0.92 : 0.04,
          normal: level === 'normal' ? 0.92 : 0.04,
          easy: level === 'easy' ? 0.92 : 0.04,
        },
      },
    },
  }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/** A fetch double that records every call. */
function recordingFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** Key resolution that can never reach the real environment or key file. */
const NO_KEY_DEPS = { env: {}, readKeyFile: () => '' }

/** Every route blank, so a test states exactly which tiers it configures. */
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

function adapter(overrides, options = {}) {
  const ctx = {
    get: () => undefined,
    logger: { info: () => {} },
    llm: { prepareCall: async () => { throw new Error('unused') } },
  }
  return new TierRouterAdapter(ctx, () => settings(overrides), {
    jevKeyDeps: NO_KEY_DEPS,
    ...options,
  })
}

function optionsFor(text) {
  return {
    provider: 'tier-router',
    model: 'smart',
    messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
    signal: undefined,
  }
}

// ---------- the question ----------

test('jev: the question is a three-option choice over the router vocabulary', () => {
  assert.equal(buildJevRequest({ state: {} }).questions[JEV_QUESTION_ID].type, 'choice')
  assert.deepEqual([...JEV_TIER_OPTIONS].sort(), ['easy', 'hard', 'normal'])
  const criteria = buildJevRequest({ state: {} }).questions[JEV_QUESTION_ID].criteria
  // Each option must stand on its own: a description, the neighbour it is NOT
  // for, and example inputs — the documented way to separate options that get
  // confused (here normal vs hard).
  for (const option of JEV_TIER_OPTIONS) {
    assert.ok(typeof criteria[option].what === 'string' && criteria[option].what !== '', `${option} needs a description`)
    assert.ok(typeof criteria[option].not_for === 'string' && criteria[option].not_for !== '', `${option} needs a not_for`)
    assert.ok(Array.isArray(criteria[option].examples) && criteria[option].examples.length > 0, `${option} needs examples`)
  }
})

test('jev: the request body carries the state, the model and one question', () => {
  const state = { version: 'routing-state-v1', userTask: '重构一下' }
  const body = buildJevRequest({ state })
  assert.deepEqual(body.state, state)
  assert.equal(body.model, JEV_DEFAULT_MODEL)
  assert.deepEqual(Object.keys(body.questions), [JEV_QUESTION_ID])
  // An empty model string falls back to the alias rather than sending "".
  assert.equal(buildJevRequest({ state, model: '' }).model, JEV_DEFAULT_MODEL)
})

test('jev: the endpoint tolerates a base URL with or without a trailing slash', () => {
  assert.equal(jevEndpoint('https://api.typesafe.ai'), 'https://api.typesafe.ai/v1/systemone')
  assert.equal(jevEndpoint('https://api.typesafe.ai/'), 'https://api.typesafe.ai/v1/systemone')
  assert.equal(jevEndpoint(''), 'https://api.typesafe.ai/v1/systemone')
})

// ---------- parsing ----------

test('jev: a valid answer yields the level, confidence, probabilities and model', () => {
  const parsed = parseJevReply(reply('hard'))
  assert.equal(parsed.level, 'hard')
  assert.equal(parsed.confidence, 0.9)
  assert.equal(parsed.model, 'jev-1.13.0')
  assert.deepEqual(Object.keys(parsed.probabilities).sort(), ['easy', 'hard', 'normal'])
})

test('jev: an option outside the three tiers is rejected, never routed on', () => {
  // Routing on an unrecognised string would send the request to an arbitrary
  // tier, so an unknown option is a hard reject.
  assert.equal(parseJevReply({ answers: { [JEV_QUESTION_ID]: { choice: 'medium', confidence: 1 } } }), undefined)
  assert.equal(parseJevReply({ answers: { [JEV_QUESTION_ID]: { choice: '', confidence: 1 } } }), undefined)
})

test('jev: an answer without a usable confidence is rejected', () => {
  // The abstention gate depends on confidence, so a response without one must
  // not be treated as a confident answer.
  assert.equal(parseJevReply({ answers: { [JEV_QUESTION_ID]: { choice: 'hard' } } }), undefined)
  assert.equal(parseJevReply({ answers: { [JEV_QUESTION_ID]: { choice: 'hard', confidence: 'high' } } }), undefined)
})

test('jev: a malformed or absent answer is rejected instead of throwing', () => {
  for (const payload of [undefined, null, {}, { answers: {} }, { answers: { [JEV_QUESTION_ID]: null } },
    { answers: { [JEV_QUESTION_ID]: 'hard' } }]) {
    assert.equal(parseJevReply(payload), undefined)
  }
})

test('jev: confidence is clamped and unknown probability keys are dropped', () => {
  const parsed = parseJevReply({
    model: 'm',
    answers: { [JEV_QUESTION_ID]: { choice: 'easy', confidence: 1.7, probabilities: { easy: 0.5, hard: 0.1, bogus: 0.4 } } },
  })
  assert.equal(parsed.confidence, 1)
  assert.deepEqual(Object.keys(parsed.probabilities).sort(), ['easy', 'hard'])
})

test('jev: probabilities render as a compact spread for the decision record', () => {
  assert.equal(
    formatJevProbabilities({ hard: 0.86, normal: 0.13, easy: 0.01 }),
    'hard 0.86 / normal 0.13 / easy 0.01',
  )
  assert.equal(formatJevProbabilities(undefined), '')
  assert.equal(formatJevProbabilities({}), '')
})

// ---------- key resolution ----------

test('jev: the key is resolved settings → environment → local TypeSafe file', () => {
  assert.deepEqual(resolveJevKey({ jevApiKey: 'from-settings' }, { env: { TYPESAFE_API_KEY: 'from-env' }, readKeyFile: () => 'from-file' }),
    { key: 'from-settings', source: 'settings' })
  assert.deepEqual(resolveJevKey({ jevApiKey: '' }, { env: { TYPESAFE_API_KEY: 'from-env' }, readKeyFile: () => 'from-file' }),
    { key: 'from-env', source: 'env' })
  assert.deepEqual(resolveJevKey({}, { env: {}, readKeyFile: () => 'from-file' }), { key: 'from-file', source: 'file' })
  assert.deepEqual(resolveJevKey({}, { env: {}, readKeyFile: () => '' }), { key: '', source: '' })
})

test('jev: surrounding whitespace in a pasted key is trimmed, and a broken key file is not fatal', () => {
  assert.equal(resolveJevKey({ jevApiKey: '  apikey-abc\n' }, NO_KEY_DEPS).key, 'apikey-abc')
  assert.deepEqual(
    resolveJevKey({}, { env: {}, readKeyFile: () => { throw new Error('EACCES') } }),
    { key: '', source: '' },
  )
})

test('jev: the memoized key file can be reset (test seam)', () => {
  resetJevKeyFileCache()
  assert.equal(typeof resolveJevKey({}, { env: {} }).key, 'string')
})

// ---------- transport ----------

test('jev: without a key nothing is sent at all', async () => {
  const fetchImpl = recordingFetch(() => response(200, reply('hard')))
  const result = await requestJevTier({ state: {}, apiKey: '', fetchImpl })
  assert.equal(result.source, 'unavailable')
  assert.equal(fetchImpl.calls.length, 0, 'a missing key must not cost a round trip')
})

test('jev: a success posts to /v1/systemone with the bearer key and returns the judgement', async () => {
  const fetchImpl = recordingFetch(() => response(200, reply('hard', { confidence: 0.77 })))
  const result = await requestJevTier({ state: { userTask: '重构' }, apiKey: 'apikey-secret', fetchImpl })
  assert.equal(result.source, 'jev')
  assert.equal(result.level, 'hard')
  assert.equal(result.confidence, 0.77)
  const [call] = fetchImpl.calls
  assert.equal(call.url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.authorization, 'Bearer apikey-secret')
  const body = JSON.parse(call.init.body)
  assert.equal(body.model, JEV_DEFAULT_MODEL)
  assert.deepEqual(body.state, { userTask: '重构' })
  assert.equal(body.questions[JEV_QUESTION_ID].type, 'choice')
})

test('jev: HTTP statuses become distinct, attributable sources', async () => {
  const cases = [
    [401, 'auth'], [403, 'auth'], [429, 'rate-limit'], [529, 'rate-limit'], [500, 'error'], [422, 'error'],
  ]
  for (const [status, expected] of cases) {
    const result = await requestJevTier({
      state: {}, apiKey: 'k', fetchImpl: recordingFetch(() => response(status, {})),
    })
    assert.equal(result.source, expected, `HTTP ${status} must map to ${expected}`)
    assert.equal(result.status, status)
  }
})

test('jev: a non-JSON body or an unusable answer is an error, not a crash', async () => {
  const notJson = await requestJevTier({
    state: {}, apiKey: 'k',
    fetchImpl: recordingFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })),
  })
  assert.equal(notJson.source, 'error')
  assert.match(notJson.detail, /not JSON/)

  const badAnswer = await requestJevTier({
    state: {}, apiKey: 'k', fetchImpl: recordingFetch(() => response(200, { answers: {} })),
  })
  assert.equal(badAnswer.source, 'error')
  assert.match(badAnswer.detail, /no usable tier answer/)
})

test('jev: a network failure surfaces its reason instead of throwing', async () => {
  const result = await requestJevTier({
    state: {}, apiKey: 'k',
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  assert.equal(result.source, 'error')
  assert.match(result.detail, /ECONNREFUSED/)
})

test('jev: the call aborts on its own budget, without waiting for the socket', async () => {
  const hanging = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
  })
  const started = Date.now()
  const result = await requestJevTier({ state: {}, apiKey: 'k', fetchImpl: hanging, timeoutMs: 30 })
  assert.equal(result.source, 'timeout')
  assert.ok(Date.now() - started < 2000, 'the budget must bound the call')
})

test('jev: an aborted request is reported as aborted, not as a failure', async () => {
  const controller = new AbortController()
  controller.abort()
  const fetchImpl = recordingFetch(() => response(200, reply('hard')))
  const result = await requestJevTier({ state: {}, apiKey: 'k', fetchImpl, signal: controller.signal })
  assert.equal(result.source, 'aborted')
  assert.equal(fetchImpl.calls.length, 0)
})

test('jev: the identity ties a cached decision to the question wording and model', () => {
  assert.notDeepEqual(jevIdentity('jev-latest'), jevIdentity('jev-preview'))
  assert.equal(jevIdentity('jev-latest').prompt, jevIdentity(undefined).prompt)
})

// ---------- router integration ----------

test('router: classifier jev routes by the judgement and records why', async () => {
  const fetchImpl = recordingFetch(() => response(200, reply('hard', { confidence: 0.86 })))
  const router = adapter({
    classifier: 'jev',
    jevApiKey: 'apikey-secret',
    hardProvider: 'p', hardModel: 'strong',
    normalProvider: 'p', normalModel: 'mid',
  }, { fetchImpl })
  const resolved = await router.resolveChain(optionsFor('这个测试偶发失败，找根因'))
  assert.equal(resolved.level, 'hard')
  assert.equal(resolved.classifier, 'jev')
  assert.equal(resolved.chain[0].model, 'strong')
  // The card must be able to tell a Jev judgement from a heuristic guess, so
  // the confidence and the spread travel with the decision.
  assert.match(resolved.cause, /confidence 0\.86/)
  assert.match(resolved.cause, /hard 0\.92/)
})

test('router: jev answers the easy tier too — the level really drives the route', async () => {
  const fetchImpl = recordingFetch(() => response(200, reply('easy')))
  const router = adapter({
    classifier: 'jev',
    jevApiKey: 'k',
    easyProvider: 'gpudev', easyModel: 'small',
    normalProvider: 'p', normalModel: 'mid',
  }, { fetchImpl })
  const resolved = await router.resolveChain(optionsFor('谢谢，收尾吧'))
  assert.equal(resolved.level, 'easy')
  assert.equal(resolved.chain[0].model, 'small')
})

test('router: the judgement is cached across the tool steps of one turn', async () => {
  const fetchImpl = recordingFetch(() => response(200, reply('normal')))
  const router = adapter({
    classifier: 'jev', jevApiKey: 'k',
    normalProvider: 'p', normalModel: 'mid',
  }, { fetchImpl })
  const first = await router.resolveChain(optionsFor('给这个函数加个参数校验'))
  const second = await router.resolveChain(optionsFor('给这个函数加个参数校验'))
  assert.equal(first.classifier, 'jev')
  assert.equal(second.classifier, 'jev-cache')
  assert.equal(fetchImpl.calls.length, 1, 'an identical turn must not pay a second round trip')
})

test('router: a low-confidence judgement abstains to the heuristic', async () => {
  const fetchImpl = recordingFetch(() => response(200, reply('easy', { confidence: 0.2 })))
  const router = adapter({
    classifier: 'jev', jevApiKey: 'k', jevMinConfidence: 0.5,
    easyProvider: 'gpudev', easyModel: 'small',
  }, { fetchImpl })
  const resolved = await router.resolveChain(optionsFor('谢谢，收尾吧'))
  assert.equal(resolved.classifier, 'jev-low-confidence')
  assert.match(resolved.cause, /abstained \(confidence 0\.20 < 0\.5\)/)
})

test('router: the confidence gate is off at 0', async () => {
  const fetchImpl = recordingFetch(() => response(200, reply('easy', { confidence: 0.05 })))
  const router = adapter({
    classifier: 'jev', jevApiKey: 'k', jevMinConfidence: 0,
    easyProvider: 'gpudev', easyModel: 'small',
  }, { fetchImpl })
  const resolved = await router.resolveChain(optionsFor('谢谢，收尾吧'))
  assert.equal(resolved.classifier, 'jev')
  assert.equal(resolved.level, 'easy')
})

test('router: a missing key abstains without any network call', async () => {
  const fetchImpl = recordingFetch(() => response(200, reply('hard')))
  const router = adapter({
    classifier: 'jev',
    hardProvider: 'p', hardModel: 'strong',
  }, { fetchImpl })
  const resolved = await router.resolveChain(optionsFor('重构 service 层'))
  assert.equal(resolved.classifier, 'jev-unavailable')
  assert.equal(fetchImpl.calls.length, 0)
  assert.match(resolved.cause, /no API key configured/)
})

test('router: a rejected key is attributed, and then not retried on every turn', async () => {
  const fetchImpl = recordingFetch(() => response(401, {}))
  const router = adapter({
    classifier: 'jev', jevApiKey: 'wrong',
    normalProvider: 'p', normalModel: 'mid',
  }, { fetchImpl })
  const first = await router.resolveChain(optionsFor('给这个函数加个参数校验'))
  assert.equal(first.classifier, 'jev-auth')
  assert.match(first.cause, /API key rejected/)
  const second = await router.resolveChain(optionsFor('另一个请求'))
  assert.equal(second.classifier, 'jev-auth', 'the backoff must be reported, not silently swallowed')
  assert.equal(fetchImpl.calls.length, 1, 'a broken credential must not cost a round trip per turn')
})

test('router: a timeout abstains to the heuristic within the budget', async () => {
  const hanging = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
  })
  const router = adapter({
    classifier: 'jev', jevApiKey: 'k', classifierTimeoutMs: 40,
    normalProvider: 'p', normalModel: 'mid',
  }, { fetchImpl: hanging })
  const started = Date.now()
  const resolved = await router.resolveChain(optionsFor('重构 service 层，涉及 a.ts b.ts c.ts 三处架构调整'))
  assert.equal(resolved.classifier, 'jev-timeout')
  assert.ok(Date.now() - started < 2000, 'classification must never stall the request')
})

test('router: a repeated structured tool failure outranks a jev verdict', async () => {
  // The model in play has already failed the same call twice; a text judgement
  // must not talk the router out of escalating.
  const fetchImpl = recordingFetch(() => response(200, reply('easy', { confidence: 0.95 })))
  const router = adapter({
    classifier: 'jev', jevApiKey: 'k',
    easyProvider: 'gpudev', easyModel: 'small',
    hardProvider: 'p', hardModel: 'strong',
  }, { fetchImpl })
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '修一下这个脚本' }], source: { kind: 'user' } },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: { command: 'npm test' } }], source: { kind: 'model' } },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'boom' }] }], source: { kind: 'tool' } },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: { command: 'npm test' } }], source: { kind: 'model' } },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'boom' }] }], source: { kind: 'tool' } },
  ]
  const resolved = await router.resolveChain({ ...optionsFor('修一下这个脚本'), messages })
  assert.equal(resolved.level, 'hard')
  assert.match(resolved.cause, /repeated structured tool failure/)
  assert.equal(resolved.chain[0].model, 'strong')
})

test('router: the API key never reaches anything the settings card renders', async () => {
  const fetchImpl = recordingFetch(() => response(200, reply('normal')))
  const stats = createStats()
  const calls = []
  const llm = {
    async prepareCall(config) {
      calls.push(`${config.provider}/${config.model}`)
      return {
        config: { provider: config.provider, model: config.model },
        async *stream() { yield { type: 'text-delta', index: 0, text: 'ok' } },
      }
    },
  }
  const ctx = { get: () => undefined, logger: { info: () => {} }, llm }
  const router = new TierRouterAdapter(ctx, () => settings({
    classifier: 'jev', jevApiKey: 'apikey-SUPERSECRET',
    normalProvider: 'p', normalModel: 'mid',
  }), { jevKeyDeps: NO_KEY_DEPS, fetchImpl, stats })
  for await (const _chunk of router.stream(optionsFor('给这个函数加个参数校验'))) { /* drain */ }
  assert.deepEqual(calls, ['p/mid'], 'the jev decision must actually drive the route')
  const snapshot = stats.snapshot()
  assert.equal(snapshot.decisions.length, 1)
  assert.equal(snapshot.decisions[0].classifier, 'jev')
  assert.match(snapshot.decisions[0].cause, /confidence/)
  assert.equal(JSON.stringify(snapshot).includes('SUPERSECRET'), false,
    'the key must never appear in the stats the card renders')
})
