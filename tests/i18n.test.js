import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Static guards on the client bundle's locale tables.
 *
 * The client half is browser code (it registers through
 * `window.__ModuleLoader__`), so it cannot be imported in Node. These tests
 * treat it as text instead — which is enough to catch the two defects that
 * matter here: Chinese leaking into the English table, and a key that exists
 * in one language but not the other.
 */
const source = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')

/** Extract a balanced `{...}` literal that follows `const <name> =`. */
function objectLiteral(name) {
  const start = source.indexOf(`const ${name} = {`)
  assert.notEqual(start, -1, `locale table "${name}" not found`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  assert.fail(`unbalanced locale table "${name}"`)
}

/** Top-level-ish string keys of a locale table, in source order. */
function keysOf(block) {
  return [...block.matchAll(/(?:^|\n)\s{6}'([A-Za-z][\w.]*)':/g)].map((m) => m[1])
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/

test('client locale: the English table carries no CJK characters', () => {
  const en = objectLiteral('en')
  const offending = en
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => CJK.test(line) && !line.trimStart().startsWith('//'))
  assert.deepEqual(offending, [], `Chinese leaked into the English locale table:\n${offending.map(([n, l]) => `${n}: ${l.trim()}`).join('\n')}`)
})

test('client locale: the Chinese table really is translated', () => {
  const zh = objectLiteral('zh')
  const translated = zh.split('\n').filter((line) => CJK.test(line))
  assert.ok(translated.length > 10, 'the zh table should be natively translated, not an English copy')
})

test('client locale: zh and en define exactly the same keys', () => {
  const zhKeys = keysOf(objectLiteral('zh'))
  const enKeys = keysOf(objectLiteral('en'))
  const onlyZh = zhKeys.filter((k) => !enKeys.includes(k))
  const onlyEn = enKeys.filter((k) => !zhKeys.includes(k))
  assert.deepEqual(onlyZh, [], 'keys missing from the English table')
  assert.deepEqual(onlyEn, [], 'keys missing from the Chinese table')
  assert.ok(enKeys.length >= 20, `expected a substantial locale table, saw ${enKeys.length} keys`)
})

test('client bundle: registers under the package name and declares its services', () => {
  assert.match(source, /__ModuleLoader__\.load\(/)
  assert.match(source, /id: 'dsh-tier-router'/)
  assert.match(source, /exports\.inject = \['slots', 'locale', 'theme'\]/)
  assert.match(source, /name: 'settings\.section'/)
})
