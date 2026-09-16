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
  classifier: 'heuristic', // 'heuristic' | 'llm'
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
  // Classification runs before the real request is sent, so it is bounded: a
  // local classifier measured ~9s warm / ~91s cold, which the user experiences
  // as the router hanging. On timeout the heuristic decides immediately and the
  // slow classifier's answer is cached for later requests.
  classifierTimeoutMs: 4000,
  // The vision sidecar spawns a real model call per new image (a Codex CLI call
  // here), also on the critical path; bound it so a hung provider cannot stall
  // the turn.
  visionTimeoutMs: 60000,
  contextGuard: true, // skip routes whose known context window cannot hold the request
})

/** Settings schema for the `tier-router` namespace. */
export const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  classifier: z.string().default('heuristic'),
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
  classifierTimeoutMs: z.number().default(4000),
  visionTimeoutMs: z.number().default(60000),
  contextGuard: z.boolean().default(true),
})

/** Tier names in routing-priority order (hard first). */
export const TIER_ORDER = ['hard', 'normal', 'easy']

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
