import { describe, expect, it } from 'vitest'
import { computerScreenshotTool } from './screenshot-tool.js'

const ctx = { taskId: 't1', signal: new AbortController().signal }

describe('computerScreenshotTool', () => {
  it('is safe and reports the captured screenshot', async () => {
    const tool = computerScreenshotTool({ screenshot: async () => ({ base64: 'ZmFrZQ==', scaleFactor: 2 }) })
    expect(tool.permissionLevel).toBe('safe')
    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/scaleFactor=2/)
  })

  it('reports a failure without throwing', async () => {
    const tool = computerScreenshotTool({
      screenshot: async () => {
        throw new Error('no display available')
      },
    })
    const result = await tool.execute({}, ctx)
    expect(result).toEqual({ ok: false, content: '', error: 'no display available' })
  })
})
