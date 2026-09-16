/**
 * dsh-tier-router — automatic model routing for DeepSeek Harness.
 *
 * Adapted from dsh-smart-router (MIT, rouyiemei/dsh-smart-router).
 *
 * Host entry: registers the virtual `tier-router` provider (model `smart`),
 * its settings namespace, and the picker HTTP API. The client half
 * (`./client/client.js`) renders the settings section.
 */

import {
  DEFAULTS, MODEL, NAMESPACE, PROVIDER, SETTINGS_SCHEMA,
} from './lib/schema.js'
import { SmartRouterAdapter, createStats } from './lib/router.js'
import { installModelsApi } from './lib/models-api.js'

/** Cordis plugin name. */
export const name = 'dsh-tier-router'
/** Host services this plugin requires. */
export const inject = ['llm']

/**
 * Register the router: settings section (flat, user-editable), adapter, and
 * the web API for the settings card.
 */
export function apply(ctx, config) {
  const entry = { ...DEFAULTS, ...(config ?? {}) }
  const stats = createStats()
  const router = new SmartRouterAdapter(ctx, () => source(), { stats })

  // Settings: schema defaults ← entry base ← user section (live source).
  // `installSection` is the local dsh-settings API (0.1.5-rc.2): it registers
  // the namespace, wires the live source, and calls `onChange` on init and on
  // every watch event.
  let source = () => entry
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, {
      setSource: (next) => {
        source = next
      },
      onChange: () => {},
    })
  })

  // Adapter + directory: the model picker discovers the provider through the
  // registered adapter; we deliberately do NOT register a configurable-provider
  // directory entry so the Settings → Models page stays clean (the router's own
  // configuration lives in its own settings section).
  const registration = ctx.llm.registerAdapter([PROVIDER], router)

  // Web API for the settings card (web-only service; dynamic inject so the
  // plugin also loads on surfaces without a web server).
  ctx.inject(['webServer'], (webCtx) => {
    installModelsApi(webCtx, () => stats)
  })

  return () => {
    registration()
  }
}

export { DEFAULTS, MODEL, NAMESPACE, PROVIDER, SETTINGS_SCHEMA }
