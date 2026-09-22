/**
 * Host HTTP API for the Tier Router settings card.
 *
 * - `GET /tier-router/api/models` — live model catalog for the pickers:
 *   every registered provider (the same registry the chat model selector
 *   uses), each model annotated with vision capability and reasoning efforts
 *   from `resolveModelInfo`, plus the current default model.
 * - `GET /tier-router/api/config` — the resolved `tier-router` settings
 *   section (schema defaults + entry base + user layer).
 * - `POST /tier-router/api/config` — write one field (`{field, value}`);
 *   `value: null` clears the field back to defaults. Only whitelisted fields
 *   are accepted.
 * - `GET /tier-router/api/stats` — in-memory route decision counters.
 *
 * The client reads and writes configuration through this API instead of the
 * settings wire: the host only exposes allow-listed namespaces to
 * configuration clients (`WEB_SETTINGS_NAMESPACES`), and a third-party
 * namespace like ours would be rejected with `settings-not-exposed`. The
 * host-side settings service has no such restriction (同 dsh-memory-evolve
 * 的自有 API 模式).
 */

import { DEFAULTS } from './schema.js'
import { resolveJevKey } from './jev.js'

/** Fields the config API accepts (flat settings schema keys). */
const CONFIG_FIELDS = new Set([
  'enabled',
  'classifier',
  'hardScore',
  'hardProvider', 'hardModel', 'hardEffort',
  'normalProvider', 'normalModel', 'normalEffort',
  'easyProvider', 'easyModel', 'easyEffort',
  'visionProvider', 'visionModel', 'visionEffort',
  'visionMode', 'visionCacheTtl',
  'visionFallbacks',
  'fallbackProvider', 'fallbackModel',
  'llmClassifierProvider', 'llmClassifierModel',
  'jevApiKey', 'jevModel', 'jevBaseUrl', 'jevMinConfidence',
  'classifierTimeoutMs', 'visionTimeoutMs',
  'contextGuard',
  'routeCooldownMs', 'routeFailureThreshold',
])

/** Resolve one provider entry's display name from the configurable directory. */
function displayNameOf(entries, providerId) {
  const entry = entries.find((candidate) => candidate.provider === providerId)
  return entry !== undefined && entry.displayName !== '' ? entry.displayName : providerId
}

/**
 * Build the picker catalog: registered providers → models → capability
 * metadata. Degrades per model (unknown vision = null, no reasoning = none).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{groups: Array<object>, failures: Array<object>, defaultModel: object|null}>}
 */
export async function buildPickerCatalog(ctx) {
  const entries = ctx.llm.listConfigurableProviders()
  const providers = ctx.llm.listProviders()
  const defaultModel = (() => {
    try {
      const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (selection && selection.provider) {
        return {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) }),
        }
      }
    } catch { /* absent */ }
    return null
  })()

  const groups = await Promise.all(providers.map(async (provider) => {
    let models = []
    try {
      const listed = await ctx.llm.listModels(provider.id)
      models = await Promise.all(listed.map(async (model) => {
        const base = {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
        }
        try {
          const info = await ctx.llm.resolveModelInfo(provider.id, model.id)
          return {
            ...base,
            vision: info.inputModalities === undefined
              ? null
              : info.inputModalities.includes('image'),
            // Surfaced so the pickers can show which models can hold a long
            // session, and why a tier was skipped by the context guard.
            ...(Number.isFinite(info.context?.contextWindow)
              ? { contextWindow: info.context.contextWindow }
              : {}),
            ...(info.reasoning === undefined
              ? {}
              : {
                  reasoningEfforts: info.reasoning.efforts.map((effort) => ({
                    id: effort.id,
                    name: effort.name,
                  })),
                  defaultEffort: info.reasoning.defaultEffort,
                }),
          }
        } catch {
          return { ...base, vision: null }
        }
      }))
    } catch (error) {
      return {
        kind: 'failure',
        failure: { id: provider.id, name: provider.name, message: String(error) },
      }
    }
    return {
      kind: 'group',
      group: {
        id: provider.id,
        name: displayNameOf(entries, provider.id),
        models,
      },
    }
  }))

  const failures = []
  const result = []
  for (const item of groups) {
    if (item.kind === 'failure') failures.push(item.failure)
    else result.push(item.group)
  }
  return { groups: result, failures, defaultModel }
}

/** Read the resolved tier-router settings section, if the service exists. */
function readConfig(ctx) {
  const settings = ctx.get?.('settings')
  if (settings === undefined) return null
  return settings.get('tier-router') ?? null
}

/**
 * What a config response may contain.
 *
 * The Jev/TypeSafe API key never leaves the host in a response: the settings
 * card only needs to know WHETHER a usable key exists (so it can show
 * "已配置" and leave the input blank for "unchanged"), plus where it came from.
 * Echoing the secret back would put it in the page's memory and in devtools
 * history for no benefit — and the card can set a new one without ever reading
 * the old one.
 *
 * "Usable" means the effective key, not just the stored field: a key picked up
 * from the environment or `~/.typesafe/key` genuinely works, and hiding that
 * would leave the card claiming "not configured" while Jev answers fine.
 *
 * @param {object} config - resolved settings section (may carry the secret).
 * @param {{env?: object, readKeyFile?: () => string}} [deps] - key-resolution seams.
 */
function maskConfig(config, deps = {}) {
  if (config === null || typeof config !== 'object') return config
  const { jevApiKey, ...rest } = config
  const resolved = resolveJevKey(config, deps)
  return { ...rest, jevKeySet: resolved.key !== '', jevKeySource: resolved.source }
}

/** Read a JSON request body (bounded). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error?.message ?? String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Register the web API under `/tier-router`.
 *
 * @param {object} ctx - host context (`settings`, `llm`, `webServer`).
 * @param {() => {snapshot: Function}} getStats - stats provider for the card.
 * @param {{env?: object, readKeyFile?: () => string}} [deps] - seams for the Jev
 *   key resolution, so a test can pin the credential source instead of
 *   inheriting whatever this machine has in `~/.typesafe/key`.
 */
export function installModelsApi(ctx, getStats, deps = {}) {
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      if (req.method === 'GET' && path === '/tier-router/api/models') {
        sendJson(res, 200, await buildPickerCatalog(ctx))
        return
      }
      if (req.method === 'GET' && path === '/tier-router/api/stats') {
        sendJson(res, 200, { stats: getStats().snapshot() })
        return
      }
      if (req.method === 'GET' && path === '/tier-router/api/config') {
        const settings = ctx.get?.('settings')
        sendJson(res, 200, {
          config: maskConfig(readConfig(ctx), deps),
          defaults: DEFAULTS,
          writable: settings?.writable ?? false,
        })
        return
      }
      if (req.method === 'POST' && path === '/tier-router/api/config') {
        const settings = ctx.get?.('settings')
        if (settings === undefined) {
          sendJson(res, 503, { error: 'settings service unavailable' })
          return
        }
        // This route is reachable without the GUI's token, so it must not be
        // usable by a page the user merely visits. `application/json` is not a
        // CORS "simple" content type: requiring it forces a preflight, which
        // this server never approves, so a cross-origin write cannot land. The
        // origin check rejects a mismatched Origin outright.
        const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
        if (!contentType.startsWith('application/json')) {
          sendJson(res, 415, { error: 'content-type must be application/json' })
          return
        }
        const origin = String(req.headers?.origin ?? '')
        if (origin !== '') {
          let originHost = ''
          try {
            originHost = new URL(origin).host
          } catch {
            originHost = 'invalid'
          }
          if (originHost !== String(req.headers?.host ?? '')) {
            sendJson(res, 403, { error: 'cross-origin config writes are rejected' })
            return
          }
        }
        const body = await readBody(req)
        const field = String(body?.field ?? '')
        if (!CONFIG_FIELDS.has(field)) {
          sendJson(res, 400, { error: `unknown config field "${field}"` })
          return
        }
        const value = body?.value
        try {
          if (value !== '' && value !== null && value !== undefined) {
            if (field === 'classifier' && !['heuristic', 'llm', 'jev'].includes(value)) throw new Error('invalid classifier')
            if (field === 'classifierTimeoutMs'
                && (!Number.isInteger(value) || value < 1 || value > 30000)) throw new Error('timeout must be 1..30000 ms')
            if (field === 'jevMinConfidence'
                && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1)) throw new Error('jevMinConfidence must be 0..1')
            if (field === 'hardScore'
                && (!Number.isInteger(value) || value < 0 || value > 10)) throw new Error('hardScore must be an integer 0..10')
          }
          // Guard the vision tier: a model that EXPLICITLY declares no image
          // input must never be stored as the vision route (DSH's own image
          // preflight uses the same inputModalities signal). Unknown
          // capability (no metadata) is allowed through — the host preflight
          // does not reject it either.
          if (field === 'visionModel' || field === 'visionProvider') {
            const provider = field === 'visionModel'
              ? String(readConfig(ctx)?.visionProvider ?? '')
              : String(value ?? '')
            const model = field === 'visionModel' ? String(value ?? '') : String(readConfig(ctx)?.visionModel ?? '')
            if (provider !== '' && model !== '') {
              try {
                const info = await ctx.llm.resolveModelInfo(provider, model)
                if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
                  sendJson(res, 400, {
                    error: `model "${provider}/${model}" does not accept image input; pick a vision-capable model for the vision tier`,
                  })
                  return
                }
              } catch { /* metadata unavailable → allow (host preflight allows too) */ }
            }
          }
          if (value === null || value === undefined || value === '') {
            await settings.mutate('tier-router', [{ op: 'unset', path: [field] }])
          } else {
            await settings.update('tier-router', { [field]: value })
          }
          sendJson(res, 200, { ok: true, config: maskConfig(readConfig(ctx), deps) })
        } catch (error) {
          sendJson(res, 400, { error: `config rejected: ${error?.message ?? String(error)}` })
        }
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error) })
    }
  }
  return ctx.webServer.register({ kind: 'prefix', path: '/tier-router', handler })
}
