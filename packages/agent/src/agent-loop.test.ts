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
})
