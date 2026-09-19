import { describe, expect, it } from 'vitest'
import { AgentLoop, SessionLog, ToolRegistry } from '@open-agent/agent'
import type { LlmAdapter, LlmRequest, LlmResponse, ToolDefinition } from '@open-agent/agent'
import { createBackgroundJobs } from './background.js'
import {
  createNonInteractiveApprovalHandler,
  createRoutingApprovalHandler,
  createTerminalApprovalHandler,
} from './approval.js'

class EchoAdapter implements LlmAdapter {
  name = 'echo'
  async generate(request: LlmRequest): Promise<LlmResponse> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')
    return { message: { role: 'assistant', content: `you said: ${lastUser?.content ?? ''}` } }
  }
}

/** An adapter that never answers until aborted, so a job can be caught mid-run. */
class GatedAdapter implements LlmAdapter {
  name = 'gated'
  generate(_request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
}

function setup(llm: LlmAdapter = new EchoAdapter()) {
  const sessions = new SessionLog()
  const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm, maxRetries: 0 })
  const output: string[] = []
  const background = createBackgroundJobs(loop, sessions, (text) => void output.push(text))
  return { sessions, background, output }
}

async function settled(background: ReturnType<typeof setup>['background'], id: string) {
  for (let i = 0; i < 50; i++) {
    const job = background.find(id)
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`job ${id} never finished`)
}

describe('createBackgroundJobs', () => {
  it('runs a job and announces its result when it finishes', async () => {
    const { background, output, sessions } = setup()
    const job = background.start('summarize the logs')

    expect((await settled(background, job.id)).result).toBe('you said: summarize the logs')
    expect(output.join('')).toMatch(/\[succeeded\] Job "summarize the logs" finished\n {2}you said: summarize the logs/)
    // Its transcript lives in the shared session log under the job's id.
    expect(sessions.findTasks()).toContain(job.id)
  })

  it('names a job after the start of a long prompt', () => {
    const { background } = setup(new GatedAdapter())
    const job = background.start('x'.repeat(200))
    expect(job.name).toHaveLength(48)
    expect(job.name.endsWith('…')).toBe(true)
  })

  it('finds a job by its id or an unambiguous prefix, with or without "job_"', () => {
    const { background } = setup(new GatedAdapter())
    const job = background.start('a')
    const short = job.id.slice('job_'.length, 'job_'.length + 4)

    expect(background.find(job.id)?.id).toBe(job.id)
    expect(background.find(short)?.id).toBe(job.id)
    expect(background.find(`job_${short}`)?.id).toBe(job.id)
    expect(background.find('zzzz')).toBeUndefined()
  })

  it('knows which task ids belong to it, retries included', () => {
    const { background } = setup(new GatedAdapter())
    const job = background.start('a')
    expect(background.owns(job.id)).toBe(true)
    expect(background.owns(`${job.id}.2`)).toBe(true)
    expect(background.owns('some-foreground-task')).toBe(false)
  })

  it('cancels a running job', async () => {
    const { background, output } = setup(new GatedAdapter())
    const job = background.start('long task')
    expect(background.cancel(job.id)).toBeDefined()
    expect((await settled(background, job.id)).status).toBe('cancelled')
    expect(output.join('')).toMatch(/was cancelled/)
  })

  it('close() stops unfinished jobs and says how many there were', async () => {
    const llm = new GatedAdapter()
    const { background } = setup(llm)
    background.start('a')
    background.start('b')
    expect(await background.close()).toBe(2)
    expect(background.list().map((job) => job.status)).toEqual(['cancelled', 'cancelled'])
    expect(await background.close()).toBe(0)
  })
})

describe('createRoutingApprovalHandler', () => {
  const tool: ToolDefinition = {
    name: 'shell',
    description: '',
    schema: {},
    permissionLevel: 'ask',
    async execute() {
      return { ok: true, content: '' }
    },
  }
  const call = { id: '1', name: 'shell', args: { cmd: 'ls' } }

  it('asks the terminal for the foreground task and never for a background job', async () => {
    const asked: string[] = []
    const logs: string[] = []
    const handler = createRoutingApprovalHandler(
      (taskId) => taskId.startsWith('job_'),
      createTerminalApprovalHandler(async (question) => {
        asked.push(question)
        return 'y'
      }),
      createNonInteractiveApprovalHandler(false, (msg) => void logs.push(msg)),
    )

    expect(await handler(call, tool, { taskId: 'foreground' })).toEqual({ approved: true, scope: 'once' })
    expect(await handler(call, tool, { taskId: 'job_abc' })).toBe(false)
    expect(asked).toHaveLength(1)
    expect(logs.join('')).toMatch(/denied "shell"/)
  })

  it('does not let a foreground "always allow" run a background job\'s call', async () => {
    const sessions = new SessionLog()
    const tools = new ToolRegistry()
    let runs = 0
    tools.register({ ...tool, execute: async () => (runs++, { ok: true, content: 'ran' }) })
    const jobs: { current?: ReturnType<typeof createBackgroundJobs> } = {}
    tools.setUnattended((taskId) => jobs.current?.owns(taskId) ?? false)
    tools.onApproval(
      createRoutingApprovalHandler(
        (taskId) => jobs.current?.owns(taskId) ?? false,
        async () => ({ approved: true, scope: 'session', match: 'tool' }),
        createNonInteractiveApprovalHandler(false, () => {}),
      ),
    )
    const callsShellOnce = (): LlmAdapter => {
      let step = 0
      return {
        name: 'calls-shell-once',
        async generate() {
          return step++ === 0
            ? { message: { role: 'assistant', content: '', toolCalls: [call] } }
            : { message: { role: 'assistant', content: 'done' } }
        },
      }
    }

    // The user approves the tool for the whole session, in the foreground.
    await new AgentLoop({ sessions, tools, llm: callsShellOnce() }).run('list files', new AbortController().signal)
    expect(runs).toBe(1)

    const background = createBackgroundJobs(
      new AgentLoop({ sessions, tools, llm: callsShellOnce() }),
      sessions,
      () => {},
    )
    jobs.current = background
    await settled(background, background.start('list files again').id)
    expect(runs).toBe(1)
  })

  it('denies an "ask" tool inside a real background run, without prompting', async () => {
    const sessions = new SessionLog()
    const tools = new ToolRegistry()
    let executed = false
    tools.register({ ...tool, execute: async () => ((executed = true), { ok: true, content: 'ran' }) })
    let prompted = false
    const jobs: { current?: ReturnType<typeof createBackgroundJobs> } = {}
    tools.onApproval(
      createRoutingApprovalHandler(
        (taskId) => jobs.current?.owns(taskId) ?? false,
        async () => ((prompted = true), true),
        createNonInteractiveApprovalHandler(false, () => {}),
      ),
    )
    let step = 0
    const llm: LlmAdapter = {
      name: 'calls-shell-once',
      async generate() {
        return step++ === 0
          ? { message: { role: 'assistant', content: '', toolCalls: [call] } }
          : { message: { role: 'assistant', content: 'gave up' } }
      },
    }
    const background = createBackgroundJobs(new AgentLoop({ sessions, tools, llm }), sessions, () => {})
    jobs.current = background

    const job = background.start('list files')
    await settled(background, job.id)

    expect(prompted).toBe(false)
    expect(executed).toBe(false)
  })
})
