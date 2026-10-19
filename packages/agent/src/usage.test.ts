import { describe, expect, it } from 'vitest'
import { AgentLoop } from './agent-loop.js'
import { SessionLog } from './session.js'
import { taskRecords } from './task-history.js'
import { ToolRegistry } from './tools.js'
import type { LlmAdapter, SessionEvent, TokenUsage } from './types.js'
import { totalUsage } from './usage.js'

/** Calls a tool, then answers; each reply reports the usage it is given. */
function billedLlm(usages: (TokenUsage | undefined)[]): LlmAdapter {
  let call = 0
  return {
    name: 'billed',
    async generate({ messages }) {
      const usage = usages[call++]
      const message = messages.some((m) => m.role === 'tool')
        ? { role: 'assistant' as const, content: 'done' }
        : { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c1', name: 'noop', args: {} }] }
      return usage ? { message, usage } : { message }
    },
  }
}

function run(usages: (TokenUsage | undefined)[]) {
  const sessions = new SessionLog()
  const tools = new ToolRegistry()
  tools.register({
    name: 'noop',
    description: '',
    schema: {},
    permissionLevel: 'safe',
    execute: async () => ({ ok: true, content: '' }),
  })
  const loop = new AgentLoop({ sessions, tools, llm: billedLlm(usages) })
  return { sessions, done: loop.run('go', new AbortController().signal, 't1') }
}

const reply = (usage?: TokenUsage): SessionEvent => ({
  type: 'assistant/message',
  taskId: 't1',
  at: 0,
  message: { role: 'assistant', content: '' },
  ...(usage ? { usage } : {}),
})

describe('token usage', () => {
  it('is logged with each reply the provider reported it for', async () => {
    const { sessions, done } = run([{ inputTokens: 100, outputTokens: 10 }, undefined])
    await done

    const replies = sessions.all('t1').filter((e) => e.type === 'assistant/message')

    expect(replies.map((e) => (e.type === 'assistant/message' ? e.usage : null))).toEqual([
      { inputTokens: 100, outputTokens: 10 },
      undefined,
    ])
  })

  it('adds up across a task, and counts cached input only where it was reported', () => {
    const total = totalUsage([
      reply({ inputTokens: 100, outputTokens: 10 }),
      reply(),
      reply({ inputTokens: 300, outputTokens: 20, cachedInputTokens: 250 }),
      { type: 'turn/end', taskId: 't1', at: 0, reason: 'completed' },
    ])

    expect(total).toEqual({ inputTokens: 400, outputTokens: 30, cachedInputTokens: 250 })
  })

  it('is unknown, not zero, when nothing reported it', () => {
    expect(totalUsage([reply(), reply()])).toBeUndefined()
    expect(totalUsage([])).toBeUndefined()
  })

  it('is part of a task record, summed over its replies', async () => {
    const { sessions, done } = run([
      { inputTokens: 100, outputTokens: 10 },
      { inputTokens: 150, outputTokens: 5 },
    ])
    await done

    expect(taskRecords(sessions.allEvents())[0].usage).toEqual({ inputTokens: 250, outputTokens: 15 })
  })

  it('is left out of a task record when the provider never reported it', async () => {
    const { sessions, done } = run([undefined, undefined])
    await done

    expect(taskRecords(sessions.allEvents())[0]).not.toHaveProperty('usage')
  })
})
