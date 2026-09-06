import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

  it("discovers browser-use's MCP tools and applies the permission policy", async () => {
    browserUse = new BrowserUseTools(options)
    await browserUse.connect()
    const tools = await browserUse.tools()

    // `__env` is the fixture's own test-only tool, not one of browser-use's;
    // it reports the environment the subprocess was started with so the
    // isolation tests below can assert what was passed through.
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.permissionLevel]))
    expect(byName).toEqual({
      __env: 'safe',
      browser_navigate: 'safe',
      browser_click: 'safe',
      browser_type: 'safe',
      browser_scroll: 'safe',
      browser_screenshot: 'safe',
      browser_get_state: 'safe',
      browser_extract_content: 'safe',
      browser_get_html: 'safe',
      browser_list_tabs: 'safe',
      browser_switch_tab: 'safe',
      browser_close_tab: 'safe',
      retry_with_browser_use_agent: 'ask',
      browser_close_session: 'ask',
      browser_close_all: 'ask',
    })
  })

  it('executes a browsing tool through the adapted ToolDefinition', async () => {
    browserUse = new BrowserUseTools(options)
    await browserUse.connect()
    const tools = await browserUse.tools()

    // test navigate
    const navigate = tools.find((t) => t.name === 'browser_navigate')!
    const res1 = await navigate.execute(
      { url: 'https://example.com' },
      { taskId: 't1', signal: new AbortController().signal },
    )
    expect(res1).toEqual({ ok: true, content: 'navigated to https://example.com' })

    // test click
    const click = tools.find((t) => t.name === 'browser_click')!
    const res2 = await click.execute({ index: 5 }, { taskId: 't1', signal: new AbortController().signal })
    expect(res2).toEqual({ ok: true, content: 'clicked element at index 5' })

    // test type
    const type = tools.find((t) => t.name === 'browser_type')!
    const res3 = await type.execute({ index: 2, text: 'hello' }, { taskId: 't1', signal: new AbortController().signal })
    expect(res3).toEqual({ ok: true, content: 'typed "hello" into element at index 2' })

    // test screenshot
    const screenshot = tools.find((t) => t.name === 'browser_screenshot')!
    const res4 = await screenshot.execute({}, { taskId: 't1', signal: new AbortController().signal })
    expect(res4).toEqual({ ok: true, content: '[screenshot captured]' })
  })
})

describe('mountBrowserUseTools', () => {
  it('registers every browser-use tool on the given ToolRegistry, gated by its permission level', async () => {
    const registry = new ToolRegistry()
    const dispose = await mountBrowserUseTools(registry, options)

    expect(
      registry
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(
      [
        '__env',
        'browser_close_all',
        'browser_close_session',
        'browser_close_tab',
        'browser_click',
        'browser_extract_content',
        'browser_get_html',
        'browser_get_state',
        'browser_list_tabs',
        'browser_navigate',
        'browser_screenshot',
        'browser_scroll',
        'browser_switch_tab',
        'browser_type',
        'retry_with_browser_use_agent',
      ].sort(),
    )

    const safeResult = await registry.execute(
      { id: 'c1', name: 'browser_navigate', args: { url: 'https://example.com' } },
      { taskId: 't1', signal: new AbortController().signal },
    )
    expect(safeResult.ok).toBe(true)

    const gatedResult1 = await registry.execute(
      { id: 'c2', name: 'browser_close_all', args: {} },
      { taskId: 't1', signal: new AbortController().signal },
    )
    expect(gatedResult1.ok).toBe(false)
    expect(gatedResult1.error).toMatch(/approval/)

    const gatedResult2 = await registry.execute(
      { id: 'c3', name: 'browser_close_session', args: {} },
      { taskId: 't1', signal: new AbortController().signal },
    )
    expect(gatedResult2.ok).toBe(false)
    expect(gatedResult2.error).toMatch(/approval/)

    dispose()
  })
})

describe('browser isolation', () => {
  let browserUse: BrowserUseTools | undefined

  afterEach(async () => {
    await browserUse?.dispose()
    browserUse = undefined
  })

  /** The environment the fixture subprocess actually received. */
  async function subprocessEnv(tools: BrowserUseTools): Promise<Record<string, string>> {
    const env = (await tools.tools()).find((tool) => tool.name === '__env')!
    const result = await env.execute({}, { taskId: 't1', signal: new AbortController().signal })
    return JSON.parse(result.content)
  }

  it('provisions a throwaway profile rather than using the real browser', async () => {
    browserUse = new BrowserUseTools(options)
    await browserUse.connect()

    const profile = browserUse.browserProfile!
    expect(profile.shared).toBe(false)
    expect(await subprocessEnv(browserUse)).toMatchObject({ BROWSER_USE_USER_DATA_DIR: profile.dir })
  })

  it('removes the provisioned profile on dispose', async () => {
    browserUse = new BrowserUseTools(options)
    await browserUse.connect()
    const dir = browserUse.browserProfile!.dir

    await browserUse.dispose()
    browserUse = undefined

    await expect(fs.stat(dir)).rejects.toThrow()
  })

  it('shares a named profile, and marks it as shared', async () => {
    const mine = await fs.mkdtemp(path.join(os.tmpdir(), 'real-profile-'))
    try {
      browserUse = new BrowserUseTools({ ...options, profileDir: mine })
      await browserUse.connect()

      expect(browserUse.browserProfile!.shared).toBe(true)
      expect(await subprocessEnv(browserUse)).toMatchObject({ BROWSER_USE_USER_DATA_DIR: mine })

      await browserUse.dispose()
      browserUse = undefined
      // Still there: it is the user's directory.
      expect((await fs.stat(mine)).isDirectory()).toBe(true)
    } finally {
      await fs.rm(mine, { recursive: true, force: true })
    }
  })

  it('keeps the agent API keys out of the browser subprocess', async () => {
    // browser-use is a third-party program, and anything it prints comes back
    // as tool output. It has no business seeing the keys the agent runs on.
    process.env.OPENAI_API_KEY = 'sk-live-should-not-leak'
    process.env.GH_TOKEN = 'ghp-should-not-leak'
    try {
      browserUse = new BrowserUseTools(options)
      await browserUse.connect()

      const env = await subprocessEnv(browserUse)

      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.GH_TOKEN).toBeUndefined()
      expect(env.PATH).toBeDefined()
    } finally {
      delete process.env.OPENAI_API_KEY
      delete process.env.GH_TOKEN
    }
  })

  it('passes through a credential the operator named', async () => {
    process.env.GH_TOKEN = 'ghp-allowed'
    try {
      browserUse = new BrowserUseTools({ ...options, allowEnv: ['GH_TOKEN'] })
      await browserUse.connect()
      expect((await subprocessEnv(browserUse)).GH_TOKEN).toBe('ghp-allowed')
    } finally {
      delete process.env.GH_TOKEN
    }
  })

  it('lets an explicit env entry win over the profile default', async () => {
    browserUse = new BrowserUseTools({ ...options, env: { BROWSER_USE_USER_DATA_DIR: '/somewhere/chosen' } })
    await browserUse.connect()
    expect((await subprocessEnv(browserUse)).BROWSER_USE_USER_DATA_DIR).toBe('/somewhere/chosen')
  })
})
