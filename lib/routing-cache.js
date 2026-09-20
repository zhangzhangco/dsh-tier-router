import { createHash } from 'node:crypto'

export function classificationKey(input, identity = {}) {
  return createHash('sha256').update(JSON.stringify({ identity, input })).digest('hex')
}

/** Shared in-flight work has its own lifetime; aborting a waiter cannot cancel another. */
export class ClassificationScheduler {
  constructor(cache, { lifetimeMs = 30000, maxPending = 32 } = {}) {
    this.cache = cache
    this.pending = new Map()
    this.lifetimeMs = lifetimeMs
    this.maxPending = maxPending
  }
  async run(key, work, { signal, timeoutMs = 4000 } = {}) {
    if (signal?.aborted) return { source: 'aborted' }
    timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, this.lifetimeMs) : 4000
    const cached = this.cache.get(key)
    if (cached !== undefined) return { ...cached, source: 'cache' }
    let entry = this.pending.get(key)
    if (!entry) {
      if (this.pending.size >= this.maxPending) return { source: 'busy' }
      const controller = new AbortController()
      entry = { controller }
      let timer, onAbort
      const expiry = new Promise(resolve => {
        onAbort = () => resolve({ source: 'aborted' })
        controller.signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => { resolve({ source: 'timeout' }); controller.abort() }, this.lifetimeMs)
      })
      const task = Promise.resolve().then(() => work(controller.signal)).catch(() => ({ source: 'error' }))
      entry.promise = Promise.race([task, expiry]).then(result => {
        if (!controller.signal.aborted && ['easy', 'normal', 'hard'].includes(result?.level)) this.cache.set(key, result)
        return result ?? { source: 'error' }
      }).finally(() => { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); this.pending.delete(key) })
      this.pending.set(key, entry)
    }
    let timer, onAbort
    try {
      return await Promise.race([
        entry.promise,
        new Promise(resolve => {
          timer = setTimeout(() => resolve({ source: 'timeout' }), timeoutMs)
          onAbort = () => resolve({ source: 'aborted' })
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted) onAbort()
        }),
      ])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  dispose() {
    for (const entry of this.pending.values()) entry.controller.abort()
  }
}
