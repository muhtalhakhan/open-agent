import { describe, expect, it, vi } from 'vitest'
import { windowFocusTool } from './window-focus-tool.js'
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

describe('windowFocusTool', () => {
  it('is ask and focuses the requested window id', async () => {
    const focus = vi.fn(async () => {})
    const tool = windowFocusTool(fakeOperator({ focus }))
    expect(tool.permissionLevel).toBe('ask')

    const result = await tool.execute({ windowId: 'w1' }, ctx)

    expect(focus).toHaveBeenCalledWith('w1')
    expect(result).toEqual({ ok: true, content: 'Window w1 focused.' })
  })

  it('reports a failure without throwing', async () => {
    const tool = windowFocusTool(
      fakeOperator({
        focus: async () => {
          throw new Error('window not found')
        },
      }),
    )

    const result = await tool.execute({ windowId: 'missing' }, ctx)

    expect(result).toEqual({ ok: false, content: '', error: 'window not found' })
  })
})
