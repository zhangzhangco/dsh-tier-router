/** Bounded model-facing evidence. Never changes the conversation being routed. */
export const ROUTING_STATE_VERSION = 'routing-state-v1'
export const ROUTING_STATE_BUDGET = 6000

export function isToolResultMessage(message) {
  return message?.source?.kind === 'tool' || (Array.isArray(message?.content)
    && message.content.length > 0 && message.content.every(b => b?.type === 'tool-result'))
}
export function isHumanMessage(message) {
  if (message?.role !== 'user' || !Array.isArray(message.content)) return false
  if (message.source?.kind === 'user') return true
  if (message.source?.kind) return false
  return !isToolResultMessage(message)
}
export function blocksText(content) {
  return (Array.isArray(content) ? content : []).filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text).join('\n')
}
function clip(value, n) {
  const text = String(value ?? '').trim()
  if (text.length <= n) return text
  const head = Math.floor((n - 5) / 2)
  return `${text.slice(0, head)}\n…\n${text.slice(-(n - head - 3))}`
}
function* blocks(content) {
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== 'object') continue
    yield b
    if (Array.isArray(b.content)) yield* blocks(b.content)
  }
}

export function buildRoutingState(options = {}, facts = {}) {
  const messages = Array.isArray(options.messages) ? options.messages : []
  const humans = messages.map((m, i) => isHumanMessage(m) ? i : -1).filter(i => i >= 0)
  const index = humans.at(-1) ?? -1
  const state = {
    version: ROUTING_STATE_VERSION,
    userTask: clip(blocksText(messages[index]?.content), 2000),
    recentConversation: [],
    agentStep: 0, hasToolHistory: false, recentTools: [],
    recentToolResult: '', recentAssistantIntent: '',
    toolErrorCount: 0, repeatedFailure: false,
    estimatedTokens: Number.isFinite(facts.estimatedTokens) ? facts.estimatedTokens : 0,
    hasImage: facts.hasImage === true,
  }
  if (index < 0) return state
  // Recent human/assistant context gives short follow-ups their referents.
  // Exclude plugin snapshots, system prompts, and private reasoning blocks.
  const start = humans.at(-4) ?? 0
  for (let i = start; i < index; i++) {
    const m = messages[i]
    if (!isHumanMessage(m) && !(m?.role === 'assistant' && (!m.source?.kind || m.source.kind === 'model'))) continue
    const text = clip(blocksText(m.content), 450)
    if (text) state.recentConversation.push({ role: m.role, text })
  }
  state.recentConversation = state.recentConversation.slice(-4)
  const calls = new Map()
  const failures = new Map()
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]
    if (m?.source?.kind === 'plugin' || m?.role === 'system') continue
    const content = [...blocks(m?.content)]
    for (const b of content) {
      if (m?.role === 'assistant' && b.type === 'tool-call') calls.set(b.id, b)
      if (i <= index) continue
      if (m?.role === 'assistant' && b.type === 'tool-call') {
        state.agentStep += 1
        state.hasToolHistory = true
        state.recentTools.push({ name: clip(b.name, 80), arguments: clip(
          typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}), 180) })
      }
      if (b.type === 'tool-result' && (m?.role === 'tool' || isToolResultMessage(m))) {
        state.hasToolHistory = true
        const result = [...blocks(b.content)].filter(x => x.type === 'text').map(x => x.text ?? '').join('\n')
        state.recentToolResult = clip(result, 1000)
        // Only structured status is evidence of failure; "error" in a file is not.
        const call = calls.get(b.toolCallId)
        const operation = call ? JSON.stringify([call.name, call.arguments]) : undefined
        if (b.isError === true) {
          state.toolErrorCount += 1
          if (operation && result.trim()) {
            const prior = failures.get(operation)
            failures.set(operation, { error: result.trim(), count: prior?.error === result.trim() ? prior.count + 1 : 1 })
          }
        } else if (b.isError === false && operation) {
          failures.delete(operation)
        }
      }
    }
    if (i > index && m?.role === 'assistant' && (!m.source?.kind || m.source.kind === 'model')) {
      const intent = blocksText(m.content)
      if (intent.trim()) state.recentAssistantIntent = clip(intent, 600)
    }
  }
  state.recentTools = state.recentTools.slice(-4)
  state.repeatedFailure = [...failures.values()].some(failure => failure.count >= 2)
  return state
}

/**
 * Trim fields, not serialized JSON; always preserve a valid evidence envelope.
 *
 * Returns the bounded OBJECT rather than its JSON, because the two consumers
 * want different things: a text classifier needs the serialized form, while a
 * structured-judgement backend (Jev) is handed the object itself so the model
 * sees named fields instead of one escaped string.
 */
export function routingStateBounded(state) {
  const bounded = structuredClone(state)
  let text = JSON.stringify(bounded)
  while (text.length > ROUTING_STATE_BUDGET) {
    if (bounded.recentConversation.length) bounded.recentConversation.shift()
    else if (bounded.recentTools.length) bounded.recentTools.shift()
    else {
      const field = ['userTask', 'recentToolResult', 'recentAssistantIntent']
        .sort((a, b) => bounded[b].length - bounded[a].length)[0]
      bounded[field] = clip(bounded[field], Math.max(20, Math.floor(bounded[field].length / 2)))
    }
    text = JSON.stringify(bounded)
  }
  return bounded
}

/** The bounded evidence envelope as text (the LLM classifier's input). */
export function routingStateInput(state) {
  return JSON.stringify(routingStateBounded(state))
}
