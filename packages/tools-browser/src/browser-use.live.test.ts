import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { BrowserUseTools } from './browser-use.js'

/**
 * Runs against the REAL browser-use MCP server (python -m browser_use.mcp),
 * not the fake fixture in browser-use.test.ts. Requires Python 3.11+ and
 * `pip install browser-use` (or `uv add browser-use`) to be reachable on
 * PATH as `python3`. Skips cleanly — rather than failing — when that isn't
 * the case, so this is safe to leave in the default test run for
 * contributors who do have it set up, without breaking CI for those who don't.
 */
function browserUseIsInstalled(): boolean {
  try {
    execFileSync('python3', ['-c', 'import browser_use'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!browserUseIsInstalled())('BrowserUseTools (live browser-use)', () => {
  it("discovers the real browser-use MCP server's tools", async () => {
    const browserUse = new BrowserUseTools()
    await browserUse.connect()
    try {
      const tools = await browserUse.tools()
      expect(tools.map((t) => t.name)).toContain('browser_navigate')
    } finally {
      browserUse.close()
    }
  }, 30_000)
})
