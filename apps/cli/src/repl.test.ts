import { describe, expect, it } from 'vitest'
import { AgentLoop, SessionLog, ToolRegistry } from '@open-agent/agent'
import type { LlmAdapter, LlmRequest, LlmResponse } from '@open-agent/agent'
import { InMemoryMemoryProvider } from '@open-agent/memory'
import { runRepl } from './repl.js'
import { createBackgroundJobs } from './background.js'
import { createTerminalAnswerStream } from './answer-stream.js'
import { createLineActivityView } from './tool-activity.js'
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
    await runRepl(loop, sessions, io, { current: null }, { memory: { provider: memory, containerTag: 'cli-user' } })

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
    await runRepl(loop, sessions, io, { current: null }, { memory: { provider: memory, containerTag: 'cli-user' } })

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
    await runRepl(loop, sessions, io, { current: null }, { memory: { provider: memory, containerTag: 'cli-user' } })

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

  it('prints each final answer through formatAnswer when one is given', async () => {
    const sessions = new SessionLog()
    const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm: new EchoAdapter() })
    const io = fakeIo(['**hi**'])
    await runRepl(loop, sessions, io, { current: null }, { formatAnswer: (answer) => `<${answer}>` })
    expect(io.output.join('')).toContain('\n<you said: **hi**>\n')
  })

  describe('background jobs', () => {
    function withBackground(inputs: string[]) {
      const sessions = new SessionLog()
      const llm = new RecordingEchoAdapter()
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm })
      const io = fakeIo(inputs)
      const background = createBackgroundJobs(loop, sessions, (text) => io.write(text))
      return { sessions, llm, loop, io, background }
    }

    it(':bg runs a task off to the side and the session carries on', async () => {
      const { loop, sessions, io, background, llm } = withBackground([':bg tidy the logs', 'hello'])
      await runRepl(loop, sessions, io, { current: null }, { background })
      await new Promise((resolve) => setImmediate(resolve))

      const out = io.output.join('')
      expect(out).toMatch(/Started job_[0-9a-f]+ in the background/)
      expect(out).toMatch(/you said: hello/)
      expect(out).toMatch(/\[succeeded\] Job "tidy the logs" finished/)
      const prompts = llm.requests.map((r) => r.messages.find((m) => m.role === 'user')?.content)
      expect(prompts).toEqual(expect.arrayContaining(['tidy the logs', 'hello']))
    })

    it(':jobs, :job and :cancel manage what is running', async () => {
      const sessions = new SessionLog()
      const neverAnswers: LlmAdapter = {
        name: 'never-answers',
        generate: (_request, signal) =>
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      }
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm: neverAnswers })
      // The IO is built once the job exists, since the commands name its id;
      // until then there is nothing for the background to write.
      const output: { io?: ReturnType<typeof fakeIo> } = {}
      const background = createBackgroundJobs(loop, sessions, (text) => output.io?.write(text))
      const job = background.start('slow one')
      const io = fakeIo([':jobs', `:job ${job.id}`, `:cancel ${job.id}`, ':job nope', ':cancel', ':bg'])
      output.io = io

      await runRepl(loop, sessions, io, { current: null }, { background })

      const out = io.output.join('')
      expect(out).toMatch(new RegExp(`${job.id} +running +slow one`))
      expect(out).toMatch(/Prompt: slow one/)
      expect(out).toMatch(new RegExp(`Cancelling ${job.id}`))
      expect(out).toMatch(/No background job matches "nope"/)
      expect(out).toMatch(/Usage: :cancel <id>/)
      expect(out).toMatch(/Background jobs:\n {2}:bg <task>/)
    })

    it('treats ":bg" as an ordinary task when background jobs are off', async () => {
      const sessions = new SessionLog()
      const llm = new RecordingEchoAdapter()
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm })
      const io = fakeIo([':bg something'])
      await runRepl(loop, sessions, io, { current: null })
      expect(io.output.join('')).toMatch(/you said: :bg something/)
    })
  })

  describe('answerStream', () => {
    /** Streams its answer in two pieces when asked to, like a real adapter would. */
    const streaming: LlmAdapter = {
      name: 'streaming',
      async generate(_request, _signal, options) {
        options?.onText?.({ type: 'delta', text: 'streamed ' })
        options?.onText?.({ type: 'delta', text: 'answer' })
        return { message: { role: 'assistant', content: 'streamed answer' } }
      },
    }

    it('shows a streamed answer as it arrives, and only once', async () => {
      const sessions = new SessionLog()
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm: streaming })
      const io = fakeIo(['go'])

      await runRepl(
        loop,
        sessions,
        io,
        { current: null },
        {
          answerStream: () => createTerminalAnswerStream((text) => io.write(text)),
        },
      )

      const out = io.output.join('')
      expect(out).toContain('\nstreamed answer\n\n')
      expect(out.split('streamed answer')).toHaveLength(2)
    })

    it('still prints the answer when the provider does not stream', async () => {
      const sessions = new SessionLog()
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm: new EchoAdapter() })
      const io = fakeIo(['hello'])

      await runRepl(
        loop,
        sessions,
        io,
        { current: null },
        {
          answerStream: () => createTerminalAnswerStream((text) => io.write(text)),
        },
      )

      expect(io.output.join('').split('you said: hello')).toHaveLength(2)
    })
  })

  describe('toolActivity', () => {
    const echoTool = {
      name: 'echo',
      description: 'echoes',
      schema: { type: 'object', properties: {} },
      permissionLevel: 'safe' as const,
      async execute(args: Record<string, unknown>) {
        return { ok: true, content: String(args.text) }
      },
    }
    /** Calls `echo` once, then answers. */
    const callsEchoOnce = (): LlmAdapter => {
      let step = 0
      return {
        name: 'calls-echo',
        async generate() {
          return step++ === 0
            ? {
                message: {
                  role: 'assistant',
                  content: '',
                  toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'hi' } }],
                },
              }
            : { message: { role: 'assistant', content: 'done' } }
        },
      }
    }

    it('shows each tool call of the foreground task as it runs, before the answer', async () => {
      const sessions = new SessionLog()
      const tools = new ToolRegistry()
      tools.register(echoTool)
      const loop = new AgentLoop({ sessions, tools, llm: callsEchoOnce() })
      const io = fakeIo(['go'])

      await runRepl(
        loop,
        sessions,
        io,
        { current: null },
        {
          toolActivity: createLineActivityView((text) => io.write(text)),
        },
      )

      const out = io.output.join('')
      expect(out).toMatch(/▸ echo \{"text":"hi"\}\n {2}ok \d+ms\n/)
      expect(out.indexOf('▸ echo')).toBeLessThan(out.indexOf('done'))
    })

    it("leaves a background job's tool calls out of the foreground view", async () => {
      const sessions = new SessionLog()
      const tools = new ToolRegistry()
      tools.register(echoTool)
      const background = createBackgroundJobs(
        new AgentLoop({ sessions, tools, llm: callsEchoOnce() }),
        sessions,
        () => {},
      )
      const job = background.start('in the background')
      // The foreground task runs while the job does, and writes to the same log.
      const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm: new EchoAdapter() })
      const io = fakeIo(['foreground'])

      await runRepl(
        loop,
        sessions,
        io,
        { current: null },
        {
          toolActivity: createLineActivityView((text) => io.write(text)),
        },
      )
      await background.close()

      expect(sessions.allEvents().some((e) => e.type === 'tool/call' && e.taskId.startsWith(job.id))).toBe(true)
      expect(io.output.join('')).not.toContain('▸')
    })
  })
})
