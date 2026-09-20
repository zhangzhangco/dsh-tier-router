import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRoutingState, routingStateInput, ROUTING_STATE_BUDGET } from '../lib/routing-state.js'
const human = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = content => ({ role: 'assistant', content })
const result = (id, text, isError = false) => ({ role: 'user', source: { kind: 'tool' }, content: [
  { type: 'tool-result', toolCallId: id, isError, content: [{ type: 'text', text }] },
] })

test('state: short continuation retains context and new tool steps change evidence', () => {
  const messages = [human('重构跨模块缓存并定位死锁'), assistant([{ type: 'text', text: '接下来测试缓存并发' }]), human('继续')]
  const initial = routingStateInput(buildRoutingState({ messages }))
  messages.push(assistant([{ type: 'tool-call', id: '1', name: 'test', arguments: '{"path":"cache"}' }]), result('1', 'timeout', true))
  const state = buildRoutingState({ messages })
  assert.equal(state.userTask, '继续')
  assert.match(initial, /跨模块/)
  assert.equal(state.agentStep, 1)
  assert.equal(state.toolErrorCount, 1)
  assert.notEqual(routingStateInput(state), initial)
  messages.push(assistant([{ type: 'tool-call', id: '2', name: 'test', arguments: '{"path":"cache"}' }]), result('2', 'timeout', true))
  assert.equal(buildRoutingState({ messages }).repeatedFailure, true)
})

test('state: ignores injected snapshots, reasoning and errors mentioned in successful output', () => {
  const state = buildRoutingState({ messages: [human('检查文件'),
    assistant([{ type: 'reasoning', text: 'private reasoning' }]), result('1', 'docs: error handling', false),
    { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'injected snapshot' }] },
  ] })
  assert.equal(state.toolErrorCount, 0)
  assert.equal(state.repeatedFailure, false)
  assert.equal(state.recentAssistantIntent, '')
  assert.doesNotMatch(routingStateInput(state), /private reasoning|injected snapshot/)
})

test('state: bounded JSON retains head and tail, never mutates request', () => {
  const messages = [human('previous '.repeat(3000)), assistant([{ type: 'text', text: 'old '.repeat(3000) }]),
    human('HEAD' + '\n"'.repeat(5000) + 'TAIL'), result('1', 'RESULT' + '\n"'.repeat(5000) + 'END')]
  const copy = structuredClone(messages)
  const input = routingStateInput(buildRoutingState({ messages }))
  assert.ok(input.length <= ROUTING_STATE_BUDGET)
  assert.match(JSON.parse(input).userTask, /HEAD/)
  assert.match(JSON.parse(input).userTask, /TAIL/)
  assert.deepEqual(messages, copy)
})

test('state: old tool errors do not contaminate a new human task', () => {
  const state = buildRoutingState({ messages: [human('old'), result('1', 'failed', true), human('你好')] })
  assert.equal(state.agentStep, 0)
  assert.equal(state.toolErrorCount, 0)
  assert.equal(state.recentToolResult, '')
})

test('state: an explicitly successful retry clears the repeated-failure flag', () => {
  const messages = [human('修复')]
  for (const [id, failed] of [['1', true], ['2', true], ['3', false]]) {
    messages.push(assistant([{ type: 'tool-call', id, name: 'test', arguments: '{}' }]), result(id, failed ? 'timeout' : 'passed', failed))
  }
  const state = buildRoutingState({ messages })
  assert.equal(state.toolErrorCount, 2)
  assert.equal(state.repeatedFailure, false)
})
