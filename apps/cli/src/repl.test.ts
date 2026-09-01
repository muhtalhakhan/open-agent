import { describe, expect, it } from 'vitest'
import { AgentLoop, SessionLog, ToolRegistry } from '@open-agent/agent'
import type { LlmAdapter, LlmRequest, LlmResponse } from '@open-agent/agent'
import { InMemoryMemoryProvider } from '@open-agent/memory'
import { runRepl } from './repl.js'
import type { AbortRef, ReplIO } from './repl.js'

function fakeIo(inputs: string[]): ReplIO & { output: string[] } {
  const queue = [...inputs]
  const output: string[] = []
  return {
    output,
    async prompt() {
      return queue.length ? queue.shift()! : null
    },
    write(text) {
      output.push(text)
    },
  }
}

class EchoAdapter implements LlmAdapter {
  name = 'echo'
  async generate(request: LlmRequest): Promise<LlmResponse> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')
    return { message: { role: 'assistant', content: `you said: ${lastUser?.content ?? ''}` } }
  }
}

describe('runRepl', () => {
  it('runs each line as a task and prints the final answer, then stops at EOF', async () => {
    const sessions = new SessionLog()
    const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm: new EchoAdapter() })
    const io = fakeIo(['hello there'])
    const activeAbort: AbortRef = { current: null }

    await runRepl(loop, sessions, io, activeAbort)

    expect(io.output.join('')).toMatch(/you said: hello there/)
  })

  it('ignores blank lines and stops on :exit without running a task', async () => {
    const sessions = new SessionLog()
    let calls = 0
    const loop = new AgentLoop({
      sessions,
      tools: new ToolRegistry(),
      llm: {
        name: 'counting',
        async generate() {
          calls++
          return { message: { role: 'assistant', content: 'ok' } }
        },
      },
    })
    const io = fakeIo(['', '  ', ':exit', 'should never run'])
    await runRepl(loop, sessions, io, { current: null })
    expect(calls).toBe(0)
  })

  it('with a memory hook: recalls before the task and remembers the answer after', async () => {
    const sessions = new SessionLog()
    const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm: new EchoAdapter() })
    const memory = new InMemoryMemoryProvider()
    await memory.remember({ content: 'the user prefers concise answers', containerTag: 'cli-user' })

    const io = fakeIo(['concise please'])
    await runRepl(loop, sessions, io, { current: null }, { provider: memory, containerTag: 'cli-user' })

    // the recalled memory should have been folded into the task sent to the model
    expect(io.output.join('')).toMatch(/concise answers/)

    // the final answer should now be stored as a new memory too
    const remembered = await memory.recall({ q: 'you said', containerTag: 'cli-user' })
    expect(remembered.length).toBeGreaterThan(0)
  })

  it('reports a non-completed task status instead of silently continuing', async () => {
    const sessions = new SessionLog()
    const loop = new AgentLoop({
      sessions,
      tools: new ToolRegistry(),
      llm: {
        name: 'always-fails',
        async generate() {
          throw new Error('provider down')
        },
      },
      maxRetries: 0,
    })
    const io = fakeIo(['do something'])
    await runRepl(loop, sessions, io, { current: null })
    expect(io.output.join('')).toMatch(/\[error\]/)
    expect(io.output.join('')).toMatch(/provider down/)
  })
})
