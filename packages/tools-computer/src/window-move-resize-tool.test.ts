import { describe, expect, it, vi } from 'vitest'
import { windowMoveResizeTool } from './window-move-resize-tool.js'
import type { WindowOperator } from './types.js'

const ctx = { taskId: 't1', signal: new AbortController().signal }

function fakeOperator(overrides: Partial<WindowOperator> = {}): WindowOperator {
  return {
    list: async () => [],
    screenshot: async () => ({ base64: 'ZmFrZQ==', scaleFactor: 1 }),
    focus: async () => {},
    setBounds: async () => {},
    ...overrides,
  }
}

describe('windowMoveResizeTool', () => {
  it('requires at least one bound change', async () => {
    const setBounds = vi.fn<WindowOperator['setBounds']>(async () => {})
    const tool = windowMoveResizeTool(fakeOperator({ setBounds }))
    const result = await tool.execute({ windowId: 'w1' }, ctx)
    expect(result).toEqual({
      ok: false,
      content: '',
      error: 'At least one of x, y, width, or height must be provided.',
    })
    expect(setBounds).not.toHaveBeenCalled()
  })

  it('calls operator with only the provided bounds', async () => {
    const setBounds = vi.fn<WindowOperator['setBounds']>(async () => {})
    const tool = windowMoveResizeTool(fakeOperator({ setBounds }))
    const result = await tool.execute({ windowId: 'w1', x: 10, height: 600 }, ctx)
    expect(result).toEqual({ ok: true, content: 'Window w1 updated (x=10, h=600).' })
    expect(setBounds).toHaveBeenCalledWith('w1', { x: 10, y: undefined, width: undefined, height: 600 })
  })

  it('reports operator failures without throwing', async () => {
    const tool = windowMoveResizeTool(
      fakeOperator({
        setBounds: async () => {
          throw new Error('unable to move window')
        },
      }),
    )
    const result = await tool.execute({ windowId: 'w1', width: 800 }, ctx)
    expect(result).toEqual({ ok: false, content: '', error: 'unable to move window' })
  })
})
