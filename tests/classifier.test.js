import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLASSIFIER_SYSTEM_PROMPT,
  DEFAULT_HARD_SCORE,
  classifyDifficulty,
  classifierInput,
  classifierRoute,
  parseClassifierReply,
} from '../lib/classifier.js'

test('heuristic: trivial greeting → easy', () => {
  const { level, reasons } = classifyDifficulty('你好，谢谢！')
  assert.equal(level, 'easy')
  assert.ok(reasons.length > 0)
})

test('heuristic: short thanks → easy', () => {
  assert.equal(classifyDifficulty('thanks!').level, 'easy')
  assert.equal(classifyDifficulty('好的，继续').level, 'easy')
})

test('heuristic: cross-file refactor request → hard', () => {
  const text = [
    '请重构 src/ 下的模块，把 user-service.js 和 order-service.js 的公共逻辑抽出来，',
    '调整 auth.js 的架构，优化数据库索引和缓存策略，性能瓶颈要定位根因。',
    '涉及 src/api/route.ts、src/db/pool.ts、src/utils/cache.ts 三个文件。',
  ].join('')
  const { level } = classifyDifficulty(text)
  assert.equal(level, 'hard')
})

test('heuristic: heavy code block → at least normal (code signal)', () => {
  const text = '```js\n' + 'const x = 1;\n'.repeat(200) + '```\n帮我看看这段代码'
  const { level, score } = classifyDifficulty(text)
  assert.ok(score >= 2)
  assert.ok(level === 'hard' || level === 'normal')
})

test('heuristic: normal single-file task', () => {
  const { level } = classifyDifficulty('在 index.js 里加一个简单的排序函数')
  assert.equal(level, 'normal')
})

test('heuristic: empty text → normal (fail-open)', () => {
  assert.equal(classifyDifficulty('').level, 'normal')
  assert.equal(classifyDifficulty(undefined).level, 'normal')
})

test('heuristic: deterministic (pure function)', () => {
  const text = '重构 service 层，涉及 a.ts b.ts c.ts 三个文件'
  const first = classifyDifficulty(text)
  const second = classifyDifficulty(text)
  assert.deepEqual(first, second)
})

test('parseClassifierReply: strict JSON', () => {
  assert.deepEqual(parseClassifierReply('{"level": "hard", "reason": "refactor"}'), {
    level: 'hard',
    reason: 'refactor',
  })
})

test('parseClassifierReply: regex fallback inside prose', () => {
  assert.deepEqual(parseClassifierReply('Here: {"level": "easy", "reason": "hi"}'), {
    level: 'easy',
    reason: 'hi',
  })
})

test('parseClassifierReply: unknown level rejected', () => {
  assert.equal(parseClassifierReply('{"level": "insane"}'), undefined)
  assert.equal(parseClassifierReply(''), undefined)
  assert.equal(parseClassifierReply('totally broken'), undefined)
})

test('classifierRoute: explicit beats easy tier', () => {
  const settings = {
    llmClassifierProvider: 'p1',
    llmClassifierModel: 'm1',
    easyProvider: 'p2',
    easyModel: 'm2',
  }
  assert.deepEqual(classifierRoute(settings), { provider: 'p1', model: 'm1' })
})

test('classifierRoute: falls back to easy tier, then undefined', () => {
  assert.deepEqual(classifierRoute({ easyProvider: 'p2', easyModel: 'm2' }), { provider: 'p2', model: 'm2' })
  assert.equal(classifierRoute({}), undefined)
})

test('classifierInput: bounded and stable', () => {
  const long = 'x'.repeat(5000)
  assert.equal(classifierInput(long).length, 2000)
  assert.equal(classifierInput('  hi  '), 'hi')
})

test('classifier prompt exists and names three tiers', () => {
  assert.ok(CLASSIFIER_SYSTEM_PROMPT.includes('hard'))
  assert.ok(CLASSIFIER_SYSTEM_PROMPT.includes('normal'))
  assert.ok(CLASSIFIER_SYSTEM_PROMPT.includes('easy'))
})

// ---------- ASCII keywords must not match inside other words ----------

test('classifyDifficulty: "hi"/"ok" do not fire inside this/which/look', () => {
  // These three used to score a bogus social signal (hi∈this, hi∈which,
  // ok∈look), drop the score by one and route to the easy tier.
  assert.equal(classifyDifficulty('which one?').level, 'normal')
  assert.equal(classifyDifficulty('this is broken').level, 'normal')
  assert.equal(classifyDifficulty('look at the logs').level, 'normal')
})

test('classifyDifficulty: genuine small talk still lands on easy', () => {
  for (const text of ['hi', 'ok', 'okay', 'thanks!', '你好', '好的', '继续']) {
    assert.equal(classifyDifficulty(text).level, 'easy', `"${text}" should be easy`)
  }
})

test('classifyDifficulty: inflected english keywords still count', () => {
  // The leading boundary must not break stems: running→run, tests→test.
  assert.equal(classifyDifficulty('running the tests now').level, 'normal')
  assert.equal(classifyDifficulty('testing the new parser').level, 'normal')
  assert.notEqual(classifyDifficulty('refactoring this module').level, 'easy')
})

test('classifyDifficulty: hardScore is the hard cut-off, defaulting to 3', () => {
  // A real request that scores 1: "migrate the whole project" carries one hard
  // keyword. It is the case the default threshold cannot reach, and the reason
  // the setting exists.
  const text = '把整个项目从 CommonJS 迁移到 ESM'
  const baseline = classifyDifficulty(text)
  assert.equal(baseline.score, 1)
  assert.equal(baseline.level, 'normal', 'the built-in threshold of 3 leaves this at normal')
  assert.equal(DEFAULT_HARD_SCORE, 3)

  assert.equal(classifyDifficulty(text, { hardScore: 1 }).level, 'hard')
  assert.equal(classifyDifficulty(text, { hardScore: 2 }).level, 'normal')

  // The score test is the FIRST branch, so a threshold at 0 still leaves small
  // talk easy — greetings score -1, which is below the cut-off.
  for (const text of ['你好', 'thanks!', 'ok']) {
    assert.equal(classifyDifficulty(text, { hardScore: 0 }).level, 'easy', text)
  }
  // Which is exactly why a negative cut-off is not allowed: -1 >= -5 would turn
  // every greeting hard. The settings schema clamps hardScore to 0..10.
  assert.equal(classifyDifficulty('hi', { hardScore: -5 }).level, 'hard')
})

test('classifyDifficulty: a missing or unusable hardScore keeps the built-in', () => {
  const text = '这个并发下的死锁帮我查一下根因' // scores 3
  for (const bad of [undefined, null, 'abc', NaN, {}]) {
    assert.equal(classifyDifficulty(text, { hardScore: bad }).level, 'hard', String(bad))
  }
  assert.equal(classifyDifficulty('把整个项目从 CommonJS 迁移到 ESM', {}).level, 'normal')
})
