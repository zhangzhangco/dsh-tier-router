import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClassificationScheduler, classificationKey } from '../lib/routing-cache.js'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('cache keys cover complete input, backend, model and prompt identity', () => {
  const prefix = 'a'.repeat(120)
  assert.notEqual(classificationKey(prefix + 'one'), classificationKey(prefix + 'two'))
  for (const field of ['backend', 'model', 'prompt', 'endpoint']) {
    assert.notEqual(classificationKey('x', { [field]: 'a' }), classificationKey('x', { [field]: 'b' }))
  }
})

test('scheduler coalesces work, isolates caller abort and caches a late answer', async () => {
  const scheduler = new ClassificationScheduler(new Map())
  let calls = 0
  const work = async () => { calls++; await delay(25); return { level: 'hard', source: 'llm' } }
  const controller = new AbortController()
  const first = scheduler.run('a', work, { signal: controller.signal })
  const timed = scheduler.run('a', work, { timeoutMs: 3 })
  const second = scheduler.run('a', work)
  controller.abort()
  assert.equal((await first).source, 'aborted')
  assert.equal((await timed).source, 'timeout')
  assert.equal((await second).level, 'hard')
  assert.equal(calls, 1)
  assert.equal((await scheduler.run('a', work)).source, 'cache')
})

test('expired work cannot overwrite a newer result; disposal releases waiters', async () => {
  const cache = new Map()
  const scheduler = new ClassificationScheduler(cache, { lifetimeMs: 8 })
  let resolveOld
  assert.equal((await scheduler.run('x', () => new Promise(resolve => { resolveOld = resolve }))).source, 'timeout')
  await scheduler.run('x', async () => ({ level: 'easy' }))
  resolveOld({ level: 'hard' })
  await delay(0)
  assert.equal(cache.get('x').level, 'easy')
  const pending = scheduler.run('y', () => new Promise(() => {}))
  scheduler.dispose()
  assert.equal((await pending).source, 'aborted')
})
