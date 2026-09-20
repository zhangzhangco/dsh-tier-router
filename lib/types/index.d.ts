/**
 * Type declarations for dsh-tier-router.
 *
 * These describe the package's public surface: the bundle entry
 * (`name` / `inject` / `apply`), the settings schema exports, and the pure
 * helpers a consumer might reasonably import. Internal wiring (the adapter's
 * stream contract) is typed by `@deepseek-ai/dsh-llm` and is intentionally
 * left to that package rather than restated here.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Difficulty tiers in routing-priority order (hardest first). */
export type TierName = 'hard' | 'normal' | 'easy'

/** The four configurable routes: three difficulty tiers plus the vision tier. */
export type RouteName = TierName | 'vision'

/** One flat route triple as stored in the `tier-router` settings namespace. */
export interface RouteTriple {
  provider: string
  model: string
  /** Reasoning effort for this tier; empty string means "unspecified". */
  effort: string
}

/** One entry of `visionFallbacks`. */
export interface VisionFallback {
  provider: string
  model: string
}

/** The resolved `tier-router` settings section (schema defaults ← base ← user). */
export interface TierRouterSettings {
  /** Master switch; when false the session default model handles the request. */
  enabled: boolean
  /** `heuristic` (built-in scoring) or `llm` (a model decides the tier). */
  classifier: 'heuristic' | 'llm'
  /** Heuristic only: score at which a request is classified `hard` (default 3). */
  hardScore: number
  hardProvider: string
  hardModel: string
  hardEffort: string
  normalProvider: string
  normalModel: string
  normalEffort: string
  easyProvider: string
  easyModel: string
  easyEffort: string
  visionProvider: string
  visionModel: string
  visionEffort: string
  /** `replace` turns images into structured evidence text; `route` sends the whole turn to the vision tier. */
  visionMode: 'replace' | 'route'
  /** Vision-evidence cache lifetime in seconds; 0 disables the cache. */
  visionCacheTtl: number
  visionFallbacks: VisionFallback[]
  /** Last-resort route; an empty provider means "use the session default model". */
  fallbackProvider: string
  fallbackModel: string
  /** Classifier model for `classifier: 'llm'`; empty means "reuse the easy tier". */
  llmClassifierProvider: string
  llmClassifierModel: string
  /**
   * Skip a route whose *known* context window cannot hold the estimated
   * request length. Models with an unknown window are never skipped, and the
   * guard never empties a chain (a routable request stays routable).
   */
  contextGuard: boolean
  classifierTimeoutMs: number
  visionTimeoutMs: number
  routeCooldownMs: number
  routeFailureThreshold: number
}

/** Settings namespace owned by this plugin. */
export declare const NAMESPACE: 'tier-router'
/** Provider route id of the virtual router. */
export declare const PROVIDER: 'tier-router'
/** Model id of the virtual router model. */
export declare const MODEL: 'smart'
/** Composition base layer: the shipped default routes for every tier. */
export declare const DEFAULTS: Readonly<TierRouterSettings>
/** Schemastery schema resolving the `tier-router` namespace. */
export declare const SETTINGS_SCHEMA: unknown
/** Tier names in routing-priority order (hard first). */
export declare const TIER_ORDER: readonly TierName[]

/** Read one tier route triple out of a resolved settings object. */
export declare function tierRoute(settings: TierRouterSettings, tier: RouteName): RouteTriple
/** Read the explicit default route (settings-level last resort). */
export declare function fallbackRoute(settings: TierRouterSettings): RouteTriple
/** Whether a route triple names an actual provider+model. */
export declare function routeConfigured(route: Partial<RouteTriple> | undefined): boolean
/** Normalize a route triple: trim, and drop an empty provider/model pair. */
export declare function normalizeRoute(route: Partial<RouteTriple> | undefined): RouteTriple

/** Cordis plugin name for this bundle. */
export declare const name: 'dsh-tier-router'
/** Host services this plugin requires. */
export declare const inject: readonly ['llm']

/**
 * Register the router: its settings section, the virtual `tier-router`
 * provider, and (where a web server exists) the settings-card API.
 *
 * @param ctx - host context; `llm` must be available.
 * @param config - composition-entry overrides folded over {@link DEFAULTS}.
 * @returns a disposer that unregisters the adapter.
 */
export declare function apply(ctx: Context, config?: Partial<TierRouterSettings>): () => void
