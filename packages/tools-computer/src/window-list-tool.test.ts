import { describe, expect, it } from 'vitest'
import { windowListTool } from './window-list-tool.js'
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

describe('windowListTool', () => {
  it('is safe and reports zero windows when none are open', async () => {
    const tool = windowListTool(fakeOperator())
    expect(tool.permissionLevel).toBe('safe')
    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/Found 0 window/)
  })

  it('renders each window on its own line with id, title, app, bounds, and flags', async () => {
    const tool = windowListTool(
      fakeOperator({
        list: async () => [
          {
            id: 'w1',
            title: 'Report.txt - Notepad',
            appName: 'notepad.exe',
            bounds: { x: 100, y: 200, width: 800, height: 600 },
            isFocused: true,
            isMinimized: false,
          },
          {
            id: 'w2',
            title: 'Inbox',
            appName: 'mail',
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            isFocused: false,
            isMinimized: true,
          },
        ],
      }),
    )
    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('Found 2 window(s)')
    expect(result.content).toContain('[w1] "Report.txt - Notepad"')
    expect(result.content).toContain('| notepad.exe')
    expect(result.content).toContain('x=100 y=200 w=800 h=600')
    expect(result.content).toContain('focused=true')
    expect(result.content).toContain('[w2] "Inbox"')
    expect(result.content).toContain('minimized=true')
  })

  it('reports a failure without throwing', async () => {
    const tool = windowListTool(
      fakeOperator({
        list: async () => {
          throw new Error('access denied')
        },
      }),
    )
    const result = await tool.execute({}, ctx)
    expect(result).toEqual({ ok: false, content: '', error: 'access denied' })
  })
})
