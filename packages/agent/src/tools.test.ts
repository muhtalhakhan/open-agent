import { describe, expect, it } from 'vitest'
import { ToolRegistry } from './tools.js'
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
