import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '@open-agent/agent'
import { computerUseTaskTool } from './computer-use-tool.js'
import type { GuiAgentFactory, GuiAgentUpdate } from './types.js'

const ctx = { taskId: 't1', signal: new AbortController().signal }

function fakeFactory(updates: GuiAgentUpdate[]): GuiAgentFactory {
  return {
    create(onUpdate) {
      return {
        async run() {
          for (const update of updates) onUpdate(update)
        },
      }
    },
  }
}

describe('computerUseTaskTool', () => {
  it('is gated behind approval', async () => {
    const tool = computerUseTaskTool(fakeFactory([]))
    expect(tool.permissionLevel).toBe('ask')
  })

  it('collects gpt-authored conversation turns into the result content', async () => {
    const tool = computerUseTaskTool(
      fakeFactory([
        { status: 'running', conversations: [{ from: 'gpt', value: 'Opening Chrome...' }] },
        { status: 'end', conversations: [{ from: 'gpt', value: 'Done — Chrome is open.' }] },
      ]),
    )
    const result = await tool.execute({ task: 'Open Chrome' }, ctx)
    expect(result).toEqual({ ok: true, content: 'Opening Chrome...\nDone — Chrome is open.' })
  })

  it('reports failure when the loop hits max_loop without finishing', async () => {
    const tool = computerUseTaskTool(fakeFactory([{ status: 'max_loop', conversations: [] }]))
    const result = await tool.execute({ task: 'Do something impossible' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/maximum loop count/)
  })

  it('is only executed once approved, like any other ask-level tool', async () => {
    const registry = new ToolRegistry()
    registry.register(
      computerUseTaskTool(fakeFactory([{ status: 'end', conversations: [{ from: 'gpt', value: 'ok' }] }])),
    )

    const denied = await registry.execute({ id: 'c1', name: 'computer_use_task', args: { task: 'x' } }, ctx)
    expect(denied.ok).toBe(false)

    registry.onApproval(() => true)
    const allowed = await registry.execute({ id: 'c2', name: 'computer_use_task', args: { task: 'x' } }, ctx)
    expect(allowed).toEqual({ ok: true, content: 'ok' })
  })
})
