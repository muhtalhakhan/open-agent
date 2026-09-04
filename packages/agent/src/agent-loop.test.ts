import { describe, expect, it } from 'vitest'
import { SessionLog } from './session.js'
import { ToolRegistry } from './tools.js'
import { AgentLoop } from './agent-loop.js'
import type { LlmAdapter, LlmRequest, LlmResponse, ToolDefinition } from './types.js'

const searchTool: ToolDefinition<{ query: string }> = {
  name: 'web_search',
  description: 'search the web',
  schema: { type: 'object', properties: { query: { type: 'string' } } },
  permissionLevel: 'safe',
  async execute(args) {
    return { ok: true, content: `results for ${args.query}` }
  },
}

/** A scripted adapter: calls a tool on the first turn, answers on the second. */
class ScriptedAdapter implements LlmAdapter {
  name = 'scripted'
  calls = 0
  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.calls++
    const hasToolResult = request.messages.some((m) => m.role === 'tool')
    if (!hasToolResult) {
      return {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'web_search', args: { query: 'latest AI news' } }],
        },
      }
    }
    return { message: { role: 'assistant', content: 'Here is your summary.' } }
  }
}

/** Records the messages of every request it is handed, then answers immediately. */
class RecordingAdapter implements LlmAdapter {
  name = 'recording'
  requests: LlmRequest[] = []
  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request)
    return { message: { role: 'assistant', content: 'done' } }
  }
}

describe('AgentLoop', () => {
  it('runs a full turn: model calls a tool, sees the result, then answers', async () => {
    const sessions = new SessionLog()
    const tools = new ToolRegistry()
    tools.register(searchTool)
    const llm = new ScriptedAdapter()
    const loop = new AgentLoop({ sessions, tools, llm })

    const task = await loop.run('summarize the latest AI news', new AbortController().signal, 't1')

    expect(task.status).toBe('completed')
    expect(llm.calls).toBe(2)
    const messages = sessions.deriveMessages('t1')
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'Here is your summary.' })

    const events = sessions.all('t1').map((e) => e.type)
    expect(events[0]).toBe('turn/start')
    expect(events.at(-1)).toBe('turn/end')
    expect(events).toContain('tool/call')
    expect(events).toContain('tool/result')
  })

  it('stops and marks the task cancelled when the signal aborts mid-run', async () => {
    const sessions = new SessionLog()
    const tools = new ToolRegistry()
    const controller = new AbortController()
    const llm: LlmAdapter = {
      name: 'never-finishes',
      async generate() {
        controller.abort()
        return { message: { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'x', args: {} }] } }
      },
    }
    const loop = new AgentLoop({ sessions, tools, llm })

    const task = await loop.run('do something long', controller.signal, 't2')
    expect(task.status).toBe('cancelled')
    expect(sessions.all('t2').at(-1)).toMatchObject({ type: 'turn/end', reason: 'cancelled' })
  })

  it('retries a transient provider failure before succeeding', async () => {
    const sessions = new SessionLog()
    const tools = new ToolRegistry()
    let attempts = 0
    const llm: LlmAdapter = {
      name: 'flaky',
      async generate() {
        attempts++
        if (attempts < 2) throw new Error('rate limited')
        return { message: { role: 'assistant', content: 'ok' } }
      },
    }
    const loop = new AgentLoop({ sessions, tools, llm, retryDelayMs: 1 })

    const task = await loop.run('hello', new AbortController().signal, 't3')
    expect(task.status).toBe('completed')
    expect(attempts).toBe(2)
    expect(sessions.all('t3').some((e) => e.type === 'retry')).toBe(true)
  })

  it('marks the task errored once retries are exhausted', async () => {
    const sessions = new SessionLog()
    const tools = new ToolRegistry()
    const llm: LlmAdapter = {
      name: 'always-fails',
      async generate() {
        throw new Error('provider down')
      },
    }
    const loop = new AgentLoop({ sessions, tools, llm, maxRetries: 1, retryDelayMs: 1 })

    const task = await loop.run('hello', new AbortController().signal, 't4')
    expect(task.status).toBe('error')
    expect(task.error).toMatch(/provider down/)
  })

  describe('systemPrompt', () => {
    it('sends the system prompt ahead of the user message', async () => {
      const sessions = new SessionLog()
      const llm = new RecordingAdapter()
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm, systemPrompt: 'Use tabs.' })

      await loop.run('hello', new AbortController().signal, 's1')

      expect(llm.requests[0].messages[0]).toEqual({ role: 'system', content: 'Use tabs.' })
      expect(llm.requests[0].messages[1]).toEqual({ role: 'user', content: 'hello' })
    })

    it('records it in the session log, not just in the request', async () => {
      const sessions = new SessionLog()
      const loop = new AgentLoop({
        sessions,
        tools: new ToolRegistry(),
        llm: new RecordingAdapter(),
        systemPrompt: 'Use tabs.',
      })

      await loop.run('hello', new AbortController().signal, 's2')

      // The log is the source of truth: what the model saw must be
      // reconstructable from it alone.
      expect(sessions.all('s2').filter((e) => e.type === 'system/message')).toHaveLength(1)
      expect(sessions.deriveMessages('s2')[0].role).toBe('system')
    })

    it('sends no system message when none is configured', async () => {
      const sessions = new SessionLog()
      const llm = new RecordingAdapter()
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm })

      await loop.run('hello', new AbortController().signal, 's3')

      expect(llm.requests[0].messages.some((m) => m.role === 'system')).toBe(false)
    })

    it('ignores a whitespace-only prompt', async () => {
      const sessions = new SessionLog()
      const llm = new RecordingAdapter()
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm, systemPrompt: '   \n  ' })

      await loop.run('hello', new AbortController().signal, 's4')

      expect(llm.requests[0].messages.some((m) => m.role === 'system')).toBe(false)
    })

    it('does not accumulate a copy per run when a taskId is reused', async () => {
      const sessions = new SessionLog()
      const llm = new RecordingAdapter()
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm, systemPrompt: 'Use tabs.' })

      await loop.run('first', new AbortController().signal, 's5')
      await loop.run('second', new AbortController().signal, 's5')

      expect(sessions.all('s5').filter((e) => e.type === 'system/message')).toHaveLength(1)
      const last = llm.requests.at(-1)!
      expect(last.messages.filter((m) => m.role === 'system')).toHaveLength(1)
      expect(last.messages[0].role).toBe('system')
    })
  })

  describe('run context', () => {
    it('joins per-turn context onto the standing system prompt, conventions first', async () => {
      const sessions = new SessionLog()
      const llm = new RecordingAdapter()
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm, systemPrompt: 'Use tabs.' })

      await loop.run('hello', new AbortController().signal, 'c1', { context: 'Recalled: prefers brevity.' })

      const system = llm.requests[0].messages[0]
      expect(system).toEqual({ role: 'system', content: 'Use tabs.\n\nRecalled: prefers brevity.' })
    })

    it('carries context on its own when no system prompt is configured', async () => {
      const sessions = new SessionLog()
      const llm = new RecordingAdapter()
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm })

      await loop.run('hello', new AbortController().signal, 'c2', { context: 'Recalled: prefers brevity.' })

      expect(llm.requests[0].messages[0]).toEqual({ role: 'system', content: 'Recalled: prefers brevity.' })
    })

    it('leaves the user message exactly as given', async () => {
      const sessions = new SessionLog()
      const llm = new RecordingAdapter()
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm })

      await loop.run('hello', new AbortController().signal, 'c3', { context: 'Recalled: prefers brevity.' })

      const user = llm.requests[0].messages.find((m) => m.role === 'user')
      expect(user).toEqual({ role: 'user', content: 'hello' })
    })

    it('sends no system message when context is empty and no prompt is set', async () => {
      const sessions = new SessionLog()
      const llm = new RecordingAdapter()
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm })

      await loop.run('hello', new AbortController().signal, 'c4', { context: '   ' })

      expect(llm.requests[0].messages.some((m) => m.role === 'system')).toBe(false)
    })
  })
})
