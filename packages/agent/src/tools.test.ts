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
