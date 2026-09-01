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

describe('createTerminalApprovalHandler', () => {
  it('approves on "y"', async () => {
    const handler = createTerminalApprovalHandler(async () => 'y')
    expect(await handler({ id: '1', name: 'shell', args: { cmd: 'ls' } }, shellTool)).toBe(true)
  })

  it('approves on "yes" case-insensitively', async () => {
    const handler = createTerminalApprovalHandler(async () => 'Yes')
    expect(await handler({ id: '1', name: 'shell', args: {} }, shellTool)).toBe(true)
  })

  it('denies on anything else, including empty input', async () => {
    const handler = createTerminalApprovalHandler(async () => '')
    expect(await handler({ id: '1', name: 'shell', args: {} }, shellTool)).toBe(false)
  })

  it('includes the tool name and args in the prompt shown to the user', async () => {
    let seenQuestion = ''
    const handler = createTerminalApprovalHandler(async (question) => {
      seenQuestion = question
      return 'n'
    })
    await handler({ id: '1', name: 'shell', args: { cmd: 'rm -rf /' } }, shellTool)
    expect(seenQuestion).toMatch(/shell/)
    expect(seenQuestion).toMatch(/rm -rf/)
  })
})
