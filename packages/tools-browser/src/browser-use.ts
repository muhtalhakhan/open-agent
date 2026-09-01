import type { Context, Disposer } from '@open-agent/context'
import type { PermissionLevel, ToolDefinition, ToolRegistry } from '@open-agent/agent'
import { McpStdioClient, mcpToolDefinition, spawnMcpServer } from '@open-agent/tools-mcp'

export interface BrowserUseOptions {
  /** Defaults to `python3 -m browser_use.mcp` (see https://github.com/browser-use/browser-use). */
  command?: string
  args?: string[]
  env?: Record<string, string>
}

/**
 * Permission policy for browser-use's MCP tools. Navigation, clicking,
 * typing, scrolling, reading page state, and tab switching stay `safe` —
 * they can't reach the filesystem or shell, matching the "browsing itself
 * isn't dangerous" stance in docs/security-model.md. Handing off to
 * browser-use's own autonomous agent (an open-ended, multi-step delegation)
 * and tearing down sessions other work may depend on require approval.
 */
const PERMISSION_OVERRIDES: Record<string, PermissionLevel> = {
  retry_with_browser_use_agent: 'ask',
  browser_close_session: 'ask',
  browser_close_all: 'ask',
}

/** Spawns browser-use's MCP server and exposes its tools as `ToolDefinition`s. */
export class BrowserUseTools {
  private client: McpStdioClient | undefined

  constructor(private readonly options: BrowserUseOptions = {}) {}

  async connect(): Promise<void> {
    this.client = await spawnMcpServer({
      command: this.options.command ?? 'python3',
      args: this.options.args ?? ['-m', 'browser_use.mcp'],
      env: this.options.env,
      clientName: 'open-agent',
    })
  }

  async tools(): Promise<ToolDefinition[]> {
    if (!this.client) throw new Error('call connect() before tools()')
    const client = this.client
    const descriptors = await client.listTools()
    return descriptors.map((descriptor) => mcpToolDefinition(client, descriptor, PERMISSION_OVERRIDES[descriptor.name] ?? 'safe'))
  }

  close(): void {
    this.client?.close()
  }
}

/**
 * Connects to browser-use and registers every tool it exposes on the given
 * registry (e.g. `ctx.get('tools')`). Returns a disposer that unregisters
 * them and closes the underlying MCP subprocess.
 */
export async function mountBrowserUseTools(
  registry: ToolRegistry,
  options: BrowserUseOptions = {},
): Promise<Disposer> {
  const browserUse = new BrowserUseTools(options)
  await browserUse.connect()
  const unregisterFns = (await browserUse.tools()).map((tool) => registry.register(tool))
  return () => {
    for (const unregister of unregisterFns) unregister()
    browserUse.close()
  }
}

export function withContext(ctx: Context, options: BrowserUseOptions = {}): Promise<Disposer> {
  const registry = ctx.get<ToolRegistry>('tools')
  if (!registry) throw new Error('ctx.tools is not mounted — install toolsPlugin from @open-agent/agent first')
  return mountBrowserUseTools(registry, options)
}
