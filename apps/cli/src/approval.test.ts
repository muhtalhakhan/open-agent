import { describe, expect, it } from 'vitest'
import { createTerminalApprovalHandler } from './approval.js'
import type { ToolDefinition } from '@open-agent/agent'

const shellTool: ToolDefinition = {
  name: 'shell',
  description: '',
  schema: {},
  permissionLevel: 'ask',
  async execute() {
    return { ok: true, content: '' }
  },
}

const dangerousTool: ToolDefinition = { ...shellTool, name: 'nuke', permissionLevel: 'dangerous' }

const call = { id: '1', name: 'shell', args: { cmd: 'ls' } }

/** Answers each prompt in turn, and records what was asked. */
function answering(...replies: string[]) {
  const asked: string[] = []
  let index = 0
  const ask = async (question: string) => {
    asked.push(question)
    return replies[index++] ?? ''
  }
  return { ask, asked }
}

describe('createTerminalApprovalHandler', () => {
  it('approves once on "y"', async () => {
    const handler = createTerminalApprovalHandler(answering('y').ask)
    expect(await handler(call, shellTool)).toEqual({ approved: true, scope: 'once' })
  })

  it('approves once on "yes" case-insensitively', async () => {
    const handler = createTerminalApprovalHandler(answering('Yes').ask)
    expect(await handler(call, shellTool)).toEqual({ approved: true, scope: 'once' })
  })

  it('denies on anything else, including empty input', async () => {
    const handler = createTerminalApprovalHandler(answering('').ask)
    expect(await handler(call, shellTool)).toEqual({ approved: false })
  })

  it('remembers for the task on "t"', async () => {
    const handler = createTerminalApprovalHandler(answering('t').ask)
    expect(await handler(call, shellTool)).toEqual({ approved: true, scope: 'task' })
  })

  it('confirms "always" a second time before removing future prompts', async () => {
    const { ask, asked } = answering('a', 'y')
    const handler = createTerminalApprovalHandler(ask)

    expect(await handler(call, shellTool)).toEqual({ approved: true, scope: 'session' })
    expect(asked).toHaveLength(2)
    expect(asked[1]).toMatch(/whole session/)
  })

  it('treats a declined confirmation as a denial, not as a one-off approval', async () => {
    // The user reached for "always", thought better of it, and said no. That
    // is not a quieter yes.
    const handler = createTerminalApprovalHandler(answering('a', 'n').ask)
    expect(await handler(call, shellTool)).toEqual({ approved: false })
  })

  it('offers a dangerous tool only once-or-no, since nothing about it is remembered', async () => {
    const { ask, asked } = answering('t')
    const handler = createTerminalApprovalHandler(ask)

    // "t" is not on offer here, so it falls through to a denial.
    expect(await handler({ ...call, name: 'nuke' }, dangerousTool)).toEqual({ approved: false })
    expect(asked[0]).not.toMatch(/task/)
    expect(asked[0]).toMatch(/\[y\]es once/)
  })

  it('lists the scopes on offer for an ask-level tool', async () => {
    const { ask, asked } = answering('n')
    await createTerminalApprovalHandler(ask)(call, shellTool)
    expect(asked[0]).toMatch(/\[t\]ask/)
    expect(asked[0]).toMatch(/\[a\]lways/)
  })

  it('includes the tool name and args in the prompt shown to the user', async () => {
    const { ask, asked } = answering('n')
    const handler = createTerminalApprovalHandler(ask)
    await handler({ id: '1', name: 'shell', args: { cmd: 'rm -rf /' } }, shellTool)
    expect(asked[0]).toMatch(/shell/)
    expect(asked[0]).toMatch(/rm -rf/)
  })
})
