import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULTS, MODEL, NAMESPACE, PROVIDER, SETTINGS_SCHEMA, TIER_ORDER,
  fallbackRoute, normalizeRoute, routeConfigured, tierRoute,
} from '../lib/schema.js'

test('namespace and provider ids are stable', () => {
  assert.equal(NAMESPACE, 'tier-router')
  assert.equal(PROVIDER, 'tier-router')
  assert.equal(MODEL, 'smart')
  assert.deepEqual(TIER_ORDER, ['hard', 'normal', 'easy'])
})

test('defaults: enabled, heuristic classifier, four configured tiers', () => {
  assert.equal(DEFAULTS.enabled, true)
  assert.equal(DEFAULTS.classifier, 'heuristic')
  assert.equal(DEFAULTS.visionMode, 'replace')
  assert.equal(DEFAULTS.visionCacheTtl, 3600)
  assert.deepEqual(DEFAULTS.visionFallbacks, [])
  // The four tiers ship pre-pointed at the author's routes; every one of them
  // is a complete provider+model pair so the ladder has something to use.
  for (const tier of [...TIER_ORDER, 'vision']) {
    const route = tierRoute(DEFAULTS, tier)
    assert.ok(route.provider !== '', `${tier}Provider default must be set`)
    assert.ok(route.model !== '', `${tier}Model default must be set`)
  }
  assert.equal(DEFAULTS.fallbackProvider, '')
  assert.equal(DEFAULTS.fallbackModel, '')
})

test('defaults: the removed seeding feature leaves no trace', () => {
  // The adaptation dropped the bundled free-vision provider seeding; the
  // schema must not still advertise those constants or fields.
  for (const gone of ['SEEDED_VISION_PROVIDERS', 'OVH_VISION_SEED', 'ZHIPU_VISION_SEED', 'escalateOnError']) {
    assert.equal(gone in DEFAULTS, false, `${gone} must not be exported by the schema`)
  }
})

test('schema: an empty section resolves every route field empty', () => {
  const resolved = SETTINGS_SCHEMA({})
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.classifier, 'heuristic')
  // schema-level route defaults are empty; the concrete tier routes live in
  // the composition base layer (DEFAULTS), which the settings service folds
  // in *below* the user section via schema(mergeLayers(base, section)).
  assert.equal(resolved.hardProvider, '')
  assert.equal(resolved.visionProvider, '')
  assert.deepEqual(resolved.visionFallbacks, [])
})

test('schema: the composition base layer carries the tier routes through', () => {
  // This is the fold the runtime performs: schema(base) — so the shipped
  // defaults must survive resolution, not be swallowed by the empty
  // schema-level route defaults.
  const resolved = SETTINGS_SCHEMA(DEFAULTS)
  for (const tier of [...TIER_ORDER, 'vision']) {
    const route = tierRoute(resolved, tier)
    assert.equal(route.provider, tierRoute(DEFAULTS, tier).provider)
    assert.equal(route.model, tierRoute(DEFAULTS, tier).model)
  }
})

test('schema: a user section overrides the base layer field-by-field', () => {
  const resolved = SETTINGS_SCHEMA({ ...DEFAULTS, hardModel: 'gpt-5.6-sol', normalEffort: 'high' })
  assert.equal(resolved.hardModel, 'gpt-5.6-sol')
  assert.equal(resolved.hardProvider, DEFAULTS.hardProvider)
  assert.equal(resolved.normalEffort, 'high')
})

test('schema: accepts a full user section', () => {
  const value = {
    enabled: false,
    classifier: 'llm',
    hardProvider: 'deepseek-official',
    hardModel: 'deepseek-v4-pro',
    hardEffort: 'max',
    visionProvider: 'deepseek-official',
    visionModel: 'deepseek-v4-flash-vision-exp',
    visionFallbacks: [{ provider: 'a', model: 'b' }],
  }
  const resolved = SETTINGS_SCHEMA(value)
  assert.equal(resolved.enabled, false)
  assert.equal(resolved.hardModel, 'deepseek-v4-pro')
  assert.equal(resolved.hardEffort, 'max')
  assert.equal(resolved.visionFallbacks[0].model, 'b')
})

test('tierRoute reads the flat triple', () => {
  const route = tierRoute({ hardProvider: 'p', hardModel: 'm', hardEffort: 'high' }, 'hard')
  assert.deepEqual(route, { provider: 'p', model: 'm', effort: 'high' })
})

test('fallbackRoute reads the explicit last-resort pair', () => {
  assert.deepEqual(fallbackRoute({ fallbackProvider: 'p', fallbackModel: 'm' }), {
    provider: 'p',
    model: 'm',
    effort: '',
  })
})

test('routeConfigured / normalizeRoute', () => {
  assert.equal(routeConfigured({ provider: 'p', model: 'm', effort: '' }), true)
  assert.equal(routeConfigured({ provider: '', model: 'm', effort: '' }), false)
  assert.equal(routeConfigured({ provider: 'p', model: '', effort: '' }), false)
  assert.deepEqual(normalizeRoute({ provider: ' p ', model: ' m ', effort: '' }), {
    provider: 'p',
    model: 'm',
    effort: '',
  })
  assert.deepEqual(normalizeRoute({ provider: 'p', model: '', effort: 'high' }), {
    provider: '',
    model: '',
    effort: '',
  })
})
