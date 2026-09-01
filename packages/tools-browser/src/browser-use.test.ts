import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolRegistry } from '@open-agent/agent'
import { BrowserUseTools, mountBrowserUseTools } from './browser-use.js'

const fixture = fileURLToPath(new URL('../test-fixtures/fake-browser-use-server.mjs', import.meta.url))
const options = { command: process.execPath, args: [fixture] }

describe('BrowserUseTools', () => {
  let browserUse: BrowserUseTools | undefined

  afterEach(() => {
    browserUse?.close()
    browserUse = undefined
  })

  it('discovers browser-use\'s MCP tools and applies the permission policy', async () => {
    browserUse = new BrowserUseTools(options)
    await browserUse.connect()
    const tools = await browserUse.tools()

    const byName = Object.fromEntries(tools.map((t) => [t.name, t.permissionLevel]))
    expect(byName).toEqual({
      browser_navigate: 'safe',
      browser_get_state: 'safe',
      retry_with_browser_use_agent: 'ask',
      browser_close_all: 'ask',
    })
  })

  it('executes a browsing tool through the adapted ToolDefinition', async () => {
    browserUse = new BrowserUseTools(options)
    await browserUse.connect()
    const tools = await browserUse.tools()
    const navigate = tools.find((t) => t.name === 'browser_navigate')!

    const result = await navigate.execute({ url: 'https://example.com' }, { taskId: 't1', signal: new AbortController().signal })
    expect(result).toEqual({ ok: true, content: 'navigated to https://example.com' })
  })
})

describe('mountBrowserUseTools', () => {
  it('registers every browser-use tool on the given ToolRegistry, gated by its permission level', async () => {
    const registry = new ToolRegistry()
    const dispose = await mountBrowserUseTools(registry, options)

    expect(registry.list().map((t) => t.name).sort()).toEqual(
      ['browser_close_all', 'browser_get_state', 'browser_navigate', 'retry_with_browser_use_agent'].sort(),
    )

    const safeResult = await registry.execute(
      { id: 'c1', name: 'browser_navigate', args: { url: 'https://example.com' } },
      { taskId: 't1', signal: new AbortController().signal },
    )
    expect(safeResult.ok).toBe(true)

    const gatedResult = await registry.execute(
      { id: 'c2', name: 'browser_close_all', args: {} },
      { taskId: 't1', signal: new AbortController().signal },
    )
    expect(gatedResult.ok).toBe(false)
    expect(gatedResult.error).toMatch(/approval/)

    dispose()
  })
})
