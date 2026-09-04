import { describe, expect, it } from 'vitest'
import { AgentLoop, SessionLog, ToolRegistry } from '@open-agent/agent'
import type { LlmAdapter, LlmRequest, LlmResponse } from '@open-agent/agent'
import { EXIT_CANCELLED, EXIT_ERROR, EXIT_OK, runHeadless } from './headless.js'
import { createNonInteractiveApprovalHandler } from './approval.js'
import type { ToolCall, ToolDefinition } from '@open-agent/agent'

class AnswerAdapter implements LlmAdapter {
  name = 'answer'
  constructor(private readonly answer: string) {}
  async generate(_request: LlmRequest): Promise<LlmResponse> {
    return { message: { role: 'assistant', content: this.answer } }
  }
}

class FailingAdapter implements LlmAdapter {
  name = 'failing'
  async generate(): Promise<LlmResponse> {
    throw new Error('provider exploded')
  }
}

function collect() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } }
}

function loopWith(llm: LlmAdapter) {
  const sessions = new SessionLog()
  return { sessions, loop: new AgentLoop({ sessions, tools: new ToolRegistry(), llm, maxRetries: 0 }) }
}

describe('runHeadless', () => {
  it('prints only the answer to stdout and exits 0', async () => {
    const { sessions, loop } = loopWith(new AnswerAdapter('42'))
    const { out, err, io } = collect()

    const code = await runHeadless(loop, sessions, {
      prompt: 'what is six times seven',
      io,
      signal: new AbortController().signal,
    })

    expect(code).toBe(EXIT_OK)
    expect(out.join('')).toBe('42\n')
    expect(err).toHaveLength(0)
  })

  it('ends the answer with exactly one newline so output composes', async () => {
    const { sessions, loop } = loopWith(new AnswerAdapter('42\n'))
    const { out, io } = collect()

    await runHeadless(loop, sessions, { prompt: 'x', io, signal: new AbortController().signal })

    expect(out.join('')).toBe('42\n')
  })

  it('exits non-zero with an empty stdout when the task fails', async () => {
    const { sessions, loop } = loopWith(new FailingAdapter())
    const { out, err, io } = collect()

    const code = await runHeadless(loop, sessions, { prompt: 'x', io, signal: new AbortController().signal })

    expect(code).toBe(EXIT_ERROR)
    expect(out.join('')).toBe('')
    expect(err.join('')).toContain('provider exploded')
  })

  it('reports cancellation with the conventional SIGINT code', async () => {
    const { sessions, loop } = loopWith(new AnswerAdapter('never gets here'))
    const { out, io } = collect()
    const controller = new AbortController()
    controller.abort()

    const code = await runHeadless(loop, sessions, { prompt: 'x', io, signal: controller.signal })

    expect(code).toBe(EXIT_CANCELLED)
    expect(out.join('')).toBe('')
  })

  it('refuses an empty task rather than sending it to the model', async () => {
    const { sessions, loop } = loopWith(new AnswerAdapter('should not run'))
    const { out, err, io } = collect()

    const code = await runHeadless(loop, sessions, { prompt: '   \n ', io, signal: new AbortController().signal })

    expect(code).toBe(EXIT_ERROR)
    expect(out.join('')).toBe('')
    expect(err.join('')).toContain('No task given')
  })
})

const askTool: ToolDefinition = {
  name: 'send_email',
  description: 'sends an email',
  schema: {},
  permissionLevel: 'ask',
  async execute() {
    return { ok: true, content: 'sent' }
  },
}
const call: ToolCall = { id: 'c1', name: 'send_email', args: {} }

describe('createNonInteractiveApprovalHandler', () => {
  it('denies by default, because nobody is present to approve', async () => {
    const logs: string[] = []
    const handler = createNonInteractiveApprovalHandler(false, (m) => logs.push(m))

    expect(await handler(call, askTool)).toBe(false)
    expect(logs.join('')).toContain('--yes')
  })

  it('approves ask-level calls when --yes was given', async () => {
    const logs: string[] = []
    const handler = createNonInteractiveApprovalHandler(true, (m) => logs.push(m))

    expect(await handler(call, askTool)).toBe(true)
    expect(logs.join('')).toContain('auto-approved')
  })

  it('cannot reach dangerous tools, which the registry gates before the handler', async () => {
    const tools = new ToolRegistry()
    tools.register({ ...askTool, name: 'rm_rf', permissionLevel: 'dangerous' })
    tools.onApproval(createNonInteractiveApprovalHandler(true, () => {}))

    const result = await tools.execute(
      { id: 'c2', name: 'rm_rf', args: {} },
      { taskId: 't', signal: new AbortController().signal },
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('approval')
  })
})
