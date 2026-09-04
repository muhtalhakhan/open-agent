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

/** EchoAdapter that also keeps every request, so tests can assert on message roles. */
class RecordingEchoAdapter extends EchoAdapter {
  requests: LlmRequest[] = []
  override async generate(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request)
    return super.generate(request)
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
    const llm = new RecordingEchoAdapter()
    const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm })
    const memory = new InMemoryMemoryProvider()
    await memory.remember({ content: 'the user prefers concise answers', containerTag: 'cli-user' })

    const io = fakeIo(['concise please'])
    await runRepl(loop, sessions, io, { current: null }, { provider: memory, containerTag: 'cli-user' })

    // the recalled memory should have reached the model
    const system = llm.requests[0].messages.find((m) => m.role === 'system')
    expect(system?.content).toMatch(/concise answers/)

    // the final answer should now be stored as a new memory too
    const remembered = await memory.recall({ q: 'you said', containerTag: 'cli-user' })
    expect(remembered.length).toBeGreaterThan(0)
  })

  it('keeps the user message free of recalled memory', async () => {
    const sessions = new SessionLog()
    const llm = new RecordingEchoAdapter()
    const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm })
    const memory = new InMemoryMemoryProvider()
    await memory.remember({ content: 'the user prefers concise answers', containerTag: 'cli-user' })

    const io = fakeIo(['concise please'])
    await runRepl(loop, sessions, io, { current: null }, { provider: memory, containerTag: 'cli-user' })

    // The logged user message must be exactly what was typed — context rides
    // in the system message, so the transcript stays faithful.
    const user = llm.requests[0].messages.find((m) => m.role === 'user')
    expect(user?.content).toBe('concise please')
    expect(user?.content).not.toMatch(/concise answers/)
  })

  it('sends no system message when nothing was recalled', async () => {
    const sessions = new SessionLog()
    const llm = new RecordingEchoAdapter()
    const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm })
    const memory = new InMemoryMemoryProvider()

    const io = fakeIo(['first thing i ever said'])
    await runRepl(loop, sessions, io, { current: null }, { provider: memory, containerTag: 'cli-user' })

    expect(llm.requests[0].messages.some((m) => m.role === 'system')).toBe(false)
  })

  it('sets a transient status while the task runs and clears it afterwards, if the IO supports it', async () => {
    const sessions = new SessionLog()
    const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm: new EchoAdapter() })
    const io = fakeIo(['hello there'])
    const statuses: (string | null)[] = []
    ;(io as ReplIO).setStatus = (text) => statuses.push(text)

    await runRepl(loop, sessions, io, { current: null })

    expect(statuses).toEqual(['thinking…', null])
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
