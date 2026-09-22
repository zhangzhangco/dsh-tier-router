/**
 * Jev (TypeSafe System One) difficulty classifier.
 *
 * The router's third classification backend, next to the built-in heuristic and
 * the optional LLM classifier. Jev is a hosted judgement model: instead of
 * generating text and parsing a JSON reply, it answers a typed `choice`
 * question and returns a probability per option plus a confidence. That makes
 * the difficulty decision a first-class value rather than a parse of prose —
 * no reply format to drift, no `{"level": ...}` to regex out of a paragraph.
 *
 * Why it fits the tier decision: the router is always choosing ONE of three
 * fixed options, which is exactly what a `choice` question is for. The
 * judgement stays narrow (one question per call) and the code owns the policy
 * (which tier, when to abstain) — see the TypeSafe "code owns the workflow"
 * split.
 *
 * Fail-open is the contract with the router: every transport, auth, parse and
 * confidence failure resolves to a named `source` instead of throwing, so the
 * caller can fall back to the heuristic and still say WHY in the settings card.
 *
 * Reference: https://docs.typesafe.ai/api (POST /v1/systemone)
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** TypeSafe API base URL (the endpoint is `<base>/v1/systemone`). */
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai'
/** TypeSafe's flagship alias; resolves server-side to a pinned build. */
export const JEV_DEFAULT_MODEL = 'jev-latest'
/** Answer id for the tier question. Ids are for code and never sent to the model. */
export const JEV_QUESTION_ID = 'tier'
/**
 * Below this confidence the judgement is treated as an abstention and the
 * heuristic decides. Three options at 1/3 each (no signal at all) score a
 * confidence near 0, so 0.3 rejects guesses while keeping a weak-but-real peak.
 * `0` disables the gate entirely.
 */
export const JEV_DEFAULT_MIN_CONFIDENCE = 0.3
/** Per-request network budget for the Jev call, in milliseconds. */
export const JEV_DEFAULT_TIMEOUT_MS = 4000
/**
 * How long to stop calling Jev after it refuses us (bad key, rate limit).
 * A wrong key otherwise costs a round trip on every single turn while the
 * settings card already explains what happened.
 */
export const JEV_BACKOFF_MS = 60_000

/**
 * Invalidates the classification cache when the question itself changes: the
 * cache key includes this string, so editing the rubric can never serve a
 * decision made under the old wording.
 */
export const JEV_PROMPT_VERSION = 'jev-tier-v1'

/**
 * The tier judgement.
 *
 * Written so each option stands on its own and the two boundaries that
 * actually get confused are stated from both sides:
 *  - `normal` vs `hard`: scope (one file / one clear change vs cross-file,
 *    design, or a repeated failure) — `not_for` says so explicitly on both.
 *  - `easy` vs `normal`: "does the request ask for any artifact at all" —
 *    `easy.not_for` is the rule, so a polite one-line *task* is not easy.
 *
 * Chinese criteria on purpose: this machine's requests are mostly Chinese, and
 * describing the levels in the same language as the state removes a
 * translation step between the request and the rubric.
 */
export const JEV_TIER_QUESTION = Object.freeze({
  type: 'choice',
  instructions: {
    question: '这次编码 agent 请求，接下来该交给哪一档模型处理？',
    focus: '只判断「接下来必须完成的那一步」的难度。不要按对话历史的长短、消息字数或上下文大小判断难度。',
    rules: [
      '只是在闲聊、确认、道谢、收尾，或让你复述已知信息 → easy',
      '要求一件具体、边界清楚、范围可预料的活 → normal',
      '要求跨文件/跨模块协调、方案或架构取舍、疑难问题的根因定位、性能或安全专项，或同一个问题已经反复失败仍要继续 → hard',
      '拿不准时选 normal',
    ],
  },
  criteria: {
    easy: {
      what: '闲聊、打招呼、道谢、确认、收尾；简短翻译或解释；只需读一个文件或回答一个已知事实',
      not_for: '任何要求你改动或产出代码、文件、配置的请求',
      examples: ['你好', '谢谢，收尾吧', '这个参数是什么意思', '把这句话翻译成英文'],
    },
    normal: {
      what: '一件边界清楚的活：单文件改动、小功能实现、按已有模式照做、写测试、常规调试',
      not_for: '需要先做方案取舍，或要同时协调多个文件/模块的请求',
      examples: [
        '给这个函数加个参数校验',
        '修一下这个空指针',
        '给 config.js 补单元测试',
      ],
    },
    hard: {
      what: '跨文件或跨模块重构、架构与方案设计、疑难 bug 的根因分析、性能或安全专项、大规模迁移；以及同一个问题反复失败后仍要继续',
      not_for: '一句话能说完、改动范围明确的日常小改',
      examples: [
        '把整个 service 层重构成依赖注入',
        '这个测试偶发失败，找根因',
        '首页加载要 8 秒，做性能优化',
        '给这套系统做上线前安全审查',
      ],
    },
  },
})

/** The three tiers, in the question's own vocabulary (rubric reading order). */
export const JEV_TIER_OPTIONS = Object.freeze(Object.keys(JEV_TIER_QUESTION.criteria))
/** Display order for a probability spread: hardest first, like the card. */
export const JEV_TIER_DISPLAY_ORDER = Object.freeze(['hard', 'normal', 'easy'])

/** Build the POST body for one difficulty judgement. */
export function buildJevRequest({ state, model = JEV_DEFAULT_MODEL } = {}) {
  return {
    state,
    model: String(model ?? '') === '' ? JEV_DEFAULT_MODEL : String(model),
    questions: { [JEV_QUESTION_ID]: JEV_TIER_QUESTION },
  }
}

/** `<base>/v1/systemone`, tolerating a base URL with or without a trailing slash. */
export function jevEndpoint(baseUrl = JEV_DEFAULT_BASE_URL) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  return `${base === '' ? JEV_DEFAULT_BASE_URL : base}/v1/systemone`
}

/**
 * Read the answer out of a System One response.
 *
 * Everything is validated: an option name outside our three tiers, a missing
 * `confidence`, or a `probabilities` map that is not an object all mean
 * "unusable", because routing a request on an unrecognised string would send
 * it to an arbitrary tier.
 *
 * @param {unknown} payload - parsed response body.
 * @returns {{level: string, confidence: number, probabilities: object, model: string}|undefined}
 */
export function parseJevReply(payload) {
  const answer = payload?.answers?.[JEV_QUESTION_ID]
  if (answer === null || typeof answer !== 'object') return undefined
  const level = String(answer.choice ?? '').trim()
  if (!JEV_TIER_OPTIONS.includes(level)) return undefined
  const rawConfidence = Number(answer.confidence)
  // Confidence is required by the API; a response without one is not trusted,
  // because the abstention gate depends on it.
  if (!Number.isFinite(rawConfidence)) return undefined
  const rawProbabilities = answer.probabilities
  const probabilities = {}
  if (rawProbabilities !== null && typeof rawProbabilities === 'object') {
    for (const option of JEV_TIER_OPTIONS) {
      const value = Number(rawProbabilities[option])
      if (Number.isFinite(value)) probabilities[option] = value
    }
  }
  return {
    level,
    confidence: Math.min(1, Math.max(0, rawConfidence)),
    probabilities,
    model: String(payload?.model ?? ''),
  }
}

/** Default key file: the local TypeSafe SDK's own credential store. */
export function defaultJevKeyPath() {
  return join(homedir(), '.typesafe', 'key')
}

/** Read (and memoize) the key file; a missing or unreadable file is not an error. */
let keyFileCache
function readKeyFile(cache = true) {
  if (cache && keyFileCache !== undefined) return keyFileCache
  let value = ''
  try {
    value = readFileSync(defaultJevKeyPath(), 'utf8').trim()
  } catch { /* no key file → empty */ }
  if (cache) keyFileCache = value
  return value
}

/** Test seam: forget the memoized key file. */
export function resetJevKeyFileCache() {
  keyFileCache = undefined
}

/**
 * Resolve the API key, most explicit source first.
 *
 * The settings field wins because that is what the user edits in the GUI; the
 * environment and the local `~/.typesafe/key` file are conveniences so an
 * already-installed TypeSafe SDK keeps working without pasting the key again.
 *
 * @param {object} settings - resolved tier-router settings.
 * @param {{env?: object, readKeyFile?: () => string}} [deps] - injection seams for tests.
 * @returns {{key: string, source: 'settings'|'env'|'file'|''}}
 */
export function resolveJevKey(settings = {}, deps = {}) {
  const fromSettings = String(settings?.jevApiKey ?? '').trim()
  if (fromSettings !== '') return { key: fromSettings, source: 'settings' }
  const env = deps.env ?? process.env
  const fromEnv = String(env?.TYPESAFE_API_KEY ?? '').trim()
  if (fromEnv !== '') return { key: fromEnv, source: 'env' }
  const read = deps.readKeyFile ?? (() => readKeyFile())
  let fromFile = ''
  try {
    fromFile = String(read?.() ?? '').trim()
  } catch { /* unreadable → no key */ }
  if (fromFile !== '') return { key: fromFile, source: 'file' }
  return { key: '', source: '' }
}

/** Render a `probabilities` map as `hard 0.86 / normal 0.13 / easy 0.01`. */
export function formatJevProbabilities(probabilities) {
  const parts = []
  for (const option of JEV_TIER_DISPLAY_ORDER) {
    const value = Number(probabilities?.[option])
    if (Number.isFinite(value)) parts.push(`${option} ${value.toFixed(2)}`)
  }
  return parts.join(' / ')
}

/**
 * Ask Jev for the tier.
 *
 * Never throws: the returned `source` names the failure so the caller can
 * attribute it in the settings card.
 *
 * @param {object} options
 * @param {unknown} options.state - structured routing evidence (the System One `state`).
 * @param {string} options.apiKey
 * @param {string} [options.model]
 * @param {string} [options.baseUrl]
 * @param {AbortSignal} [options.signal] - caller cancellation (request abort).
 * @param {number} [options.timeoutMs] - this call's own budget.
 * @param {Function} [options.fetchImpl] - injection seam for tests.
 * @returns {Promise<{source: string, level?: string, confidence?: number,
 *   probabilities?: object, model?: string, status?: number, detail?: string}>}
 */
export async function requestJevTier(options = {}) {
  const {
    state,
    apiKey,
    model = JEV_DEFAULT_MODEL,
    baseUrl = JEV_DEFAULT_BASE_URL,
    signal,
    timeoutMs = JEV_DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = options
  if (String(apiKey ?? '') === '') return { source: 'unavailable', detail: 'no api key' }
  if (typeof fetchImpl !== 'function') return { source: 'unavailable', detail: 'fetch unavailable' }
  if (signal?.aborted) return { source: 'aborted' }

  // Own controller: the caller's signal cancels, and our own timer bounds the
  // call independently of the scheduler's (much longer) shared-work lifetime.
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1, Number(timeoutMs) || JEV_DEFAULT_TIMEOUT_MS))

  try {
    const response = await fetchImpl(jevEndpoint(baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(buildJevRequest({ state, model })),
      signal: controller.signal,
    })
    const status = Number(response?.status) || 0
    if (status === 401 || status === 403) return { source: 'auth', status }
    if (status === 429 || status === 529) return { source: 'rate-limit', status }
    if (!response?.ok) return { source: 'error', status }
    let payload
    try {
      payload = await response.json()
    } catch {
      return { source: 'error', status, detail: 'response was not JSON' }
    }
    const parsed = parseJevReply(payload)
    if (parsed === undefined) return { source: 'error', status, detail: 'no usable tier answer' }
    return { source: 'jev', ...parsed }
  } catch (error) {
    if (timedOut) return { source: 'timeout', detail: `no answer within ${timeoutMs}ms` }
    if (signal?.aborted) return { source: 'aborted' }
    return { source: 'error', detail: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * The router's cache identity for one Jev judgement: the question wording, the
 * model and the evidence all take part, so a change to any of them can never
 * reuse a stale decision.
 */
export function jevIdentity(model) {
  return {
    backend: 'jev',
    model: String(model ?? '') === '' ? JEV_DEFAULT_MODEL : String(model),
    prompt: JEV_PROMPT_VERSION,
  }
}
