/**
 * dsh-tier-router settings schema and defaults.
 *
 * Adapted from dsh-smart-router (MIT, rouyiemei/dsh-smart-router) for a
 * personal DSH profile. The section is deliberately FLAT: the client
 * settings card writes one-segment paths (`write('hardProvider', …)`), and a
 * flat YAML section is easy to hand-edit:
 *
 * ```yaml
 * tier-router:
 *   enabled: true
 *   classifier: heuristic        # heuristic | llm
 *   hardScore: 3                 # heuristic: score at which a request is 'hard'
 *   hardProvider: codex-local
 *   hardModel: gpt-6-astra
 *   ...
 *   visionProvider: codex-local
 *   visionModel: gpt-6-astra
 * ```
 *
 * An empty route (provider === '' or model === '') means "this tier is not
 * configured": the router falls back to the next tier, then to the default
 * model, and never fails the request silently.
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_HARD_SCORE } from './classifier.js'
import { JEV_DEFAULT_BASE_URL, JEV_DEFAULT_MIN_CONFIDENCE, JEV_DEFAULT_MODEL } from './jev.js'

/** Settings namespace owned by this plugin. */
export const NAMESPACE = 'tier-router'

/** Provider route id of the virtual router. */
export const PROVIDER = 'tier-router'
/** Model id of the virtual router model. */
export const MODEL = 'smart'

/** A flat route triple: provider route id, model id, optional reasoning effort. */
const routeField = () => z.string().default('')

/**
 * Defaults shared by the composition entry base layer and the schema.
 *
 * Tier mapping for this machine (see the profile's cordis.patch.yml):
 *   hard   → codex-local / gpt-6-astra   (strongest local Codex route)
 *   normal → codex-local / gpt-5.5       (fast, still strong)
 *   easy   → gpudev / qwen3.8-27b-q5     (local llama.cpp, free, fast)
 *   vision → codex-local / gpt-6-astra   (text+image)
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  classifier: 'heuristic', // 'heuristic' | 'llm' | 'jev'
  // Score at which the heuristic calls a request hard. Measured on 213 real
  // requests from this machine: 79% scored exactly 0 and nothing landed between
  // 2 and 6, so 2/3/4/5 behave identically. Only 3 (the default, ~1 hard in 213)
  // and 1 (~12) are meaningfully different points.
  hardScore: DEFAULT_HARD_SCORE,
  hardProvider: 'codex-local',
  hardModel: 'gpt-6-astra',
  hardEffort: '',
  normalProvider: 'codex-local',
  normalModel: 'gpt-5.5',
  normalEffort: '',
  easyProvider: 'gpudev',
  easyModel: 'qwen3.8-27b-q5',
  easyEffort: '',
  visionProvider: 'codex-local',
  visionModel: 'gpt-6-astra',
  visionEffort: '',
  visionMode: 'replace', // 'replace' = structured evidence sidecar | 'route' = whole-turn vision tier
  visionCacheTtl: 3600, // seconds; 0 disables the evidence cache
  visionFallbacks: [],
  fallbackProvider: '',
  fallbackModel: '',
  llmClassifierProvider: '',
  llmClassifierModel: '',
  // Jev (TypeSafe System One) classifier. The key is normally pasted into the
  // settings card; `TYPESAFE_API_KEY` and `~/.typesafe/key` are fallbacks so an
  // already-installed TypeSafe SDK works with nothing to configure.
  jevApiKey: '',
  jevModel: JEV_DEFAULT_MODEL,
  jevBaseUrl: JEV_DEFAULT_BASE_URL,
  // Below this confidence Jev abstains and the heuristic decides; 0 disables
  // the gate. Three options at 1/3 each (no signal at all) score a confidence
  // near 0, so this floor rejects guesses rather than coin flips.
  jevMinConfidence: JEV_DEFAULT_MIN_CONFIDENCE,
  // Classification runs before the real request is sent, so it is bounded: a
  // local classifier measured ~9s warm / ~91s cold, which the user experiences
  // as the router hanging. On timeout the heuristic decides immediately and the
  // slow classifier's answer is cached for later requests. Jev shares this
  // budget (a measured TypeSafe round trip is ~0.8s from this machine).
  classifierTimeoutMs: 4000,
  // The vision sidecar spawns a real model call per new image (a Codex CLI call
  // here), also on the critical path; bound it so a hung provider cannot stall
  // the turn.
  visionTimeoutMs: 60000,
  contextGuard: true, // skip routes whose known context window cannot hold the request
  // A route that just told us it cannot serve (quota, credential, no adapter)
  // is benched instead of being tried again on the next request. `0` disables
  // the bench entirely.
  routeCooldownMs: 300000,
  // Consecutive failures of the same route before benching it even when the
  // failure code is uninformative. Covers the case the code cannot express:
  // an exhausted quota that surfaces only as a connection timeout.
  routeFailureThreshold: 2,
})

/** Settings schema for the `tier-router` namespace. */
export const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  classifier: z.union(['heuristic', 'llm', 'jev']).default('heuristic'),
  hardScore: z.number().min(0).max(10).default(DEFAULT_HARD_SCORE),
  hardProvider: routeField(),
  hardModel: routeField(),
  hardEffort: routeField(),
  normalProvider: routeField(),
  normalModel: routeField(),
  normalEffort: routeField(),
  easyProvider: routeField(),
  easyModel: routeField(),
  easyEffort: routeField(),
  visionProvider: routeField(),
  visionModel: routeField(),
  visionEffort: routeField(),
  visionMode: z.string().default('replace'),
  visionCacheTtl: z.number().default(3600),
  visionFallbacks: z.array(z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
  })).default([]),
  fallbackProvider: routeField(),
  fallbackModel: routeField(),
  llmClassifierProvider: routeField(),
  llmClassifierModel: routeField(),
  jevApiKey: z.string().default(''),
  jevModel: z.string().default(JEV_DEFAULT_MODEL),
  jevBaseUrl: z.string().default(JEV_DEFAULT_BASE_URL),
  jevMinConfidence: z.number().min(0).max(1).default(JEV_DEFAULT_MIN_CONFIDENCE),
  classifierTimeoutMs: z.number().min(1).max(30000).default(4000),
  visionTimeoutMs: z.number().default(60000),
  contextGuard: z.boolean().default(true),
  routeCooldownMs: z.number().default(300000),
  routeFailureThreshold: z.number().default(2),
})

/** Tier names in routing-priority order (hard first). */
export const TIER_ORDER = ['hard', 'normal', 'easy']

/**
 * The order the *other* tiers are tried in when the requested tier cannot
 * answer: nearest capability first, and — at equal distance — the harder tier
 * first.
 *
 * "Hardest first" was the old rule, and it is the wrong default for an easy
 * request: the tier it escalated to first was `hard`, so a local model that was
 * merely cold, busy or too small handed a one-line question to the most
 * expensive and quota-limited route in the ladder (typically Codex) before the
 * cheap remote workhorse in `normal` was ever tried. Nearest-first keeps a
 * fallback inside the capability band the classifier asked for — easy → normal
 * → hard — while `normal` and `hard` keep their escalation-first order
 * (normal → hard → easy, hard → normal → easy), because under-serving a
 * genuinely hard request is worse than over-serving it.
 *
 * @param {string} level - the tier the classifier requested.
 * @returns {TierName[]} the remaining tiers, in fallback order.
 */
export function tierFallbackOrder(level) {
  const requested = TIER_ORDER.indexOf(level)
  if (requested === -1) return [...TIER_ORDER]
  // `filter` copies, so the sort never mutates TIER_ORDER itself.
  return TIER_ORDER.filter((tier) => tier !== level).sort((a, b) => {
    const byDistance = Math.abs(TIER_ORDER.indexOf(a) - requested)
      - Math.abs(TIER_ORDER.indexOf(b) - requested)
    // Equal distance means the tiers sit on opposite sides of the requested
    // one; the harder tier (lower index) goes first.
    return byDistance !== 0 ? byDistance : TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b)
  })
}

/** Read one tier route triple out of a resolved settings object. */
export function tierRoute(settings, tier) {
  return {
    provider: String(settings[`${tier}Provider`] ?? ''),
    model: String(settings[`${tier}Model`] ?? ''),
    effort: String(settings[`${tier}Effort`] ?? ''),
  }
}

/** Read the explicit default route (settings-level fallback). */
export function fallbackRoute(settings) {
  return {
    provider: String(settings.fallbackProvider ?? ''),
    model: String(settings.fallbackModel ?? ''),
    effort: '',
  }
}

/** Whether a route triple names an actual provider+model. */
export function routeConfigured(route) {
  return typeof route.provider === 'string' && route.provider !== '' &&
    typeof route.model === 'string' && route.model !== ''
}

/** Normalize a route triple: trim and drop empty effort. */
export function normalizeRoute(route) {
  const provider = String(route?.provider ?? '').trim()
  const model = String(route?.model ?? '').trim()
  const effort = String(route?.effort ?? '').trim()
  if (provider === '' || model === '') return { provider: '', model: '', effort: '' }
  return { provider, model, effort }
}
