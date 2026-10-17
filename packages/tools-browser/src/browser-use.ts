import type { Context, Disposer, Plugin } from '@open-agent/context'
import type { PermissionLevel, ToolDefinition, ToolExecutionContext, ToolRegistry } from '@open-agent/agent'
import { imageAttachments, mcpToolDefinition, spawnMcpServer } from '@open-agent/tools-mcp'
import type { McpStdioClient } from '@open-agent/tools-mcp'
import { DEFAULT_PROFILE_ENV_VARS, createBrowserProfile, profileEnv, type BrowserProfile } from './profile.js'

export interface BrowserUseOptions {
  /** Defaults to `python3 -m browser_use.mcp` (see https://github.com/browser-use/browser-use). */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /**
   * Use this profile directory instead of a throwaway one. Naming the user's
   * real Chrome profile here is how profile sharing is opted into.
   */
  profileDir?: string
  /** Where throwaway profiles are provisioned (default: the OS temp dir). */
  profileBase?: string
  /** Keep a provisioned profile after closing, to inspect what the browser stored. */
  keepProfile?: boolean
  /** Environment variables that point browser-use at the profile. */
  profileEnvVars?: readonly string[]
  /** Credential-looking variables to pass through to the browser subprocess. */
  allowEnv?: readonly string[]
  /**
   * Show a screenshot of the page after each action that changes it, to
   * whoever is watching the task (default true). Costs a screenshot per
   * action, so it is only taken when a host is listening for attachments.
   */
  liveView?: boolean
  /** How long a live-view screenshot may take before it is given up (default 5s). */
  screenshotTimeoutMs?: number
}

const SCREENSHOT_TOOL = 'browser_screenshot'
/** Long enough for a full-page capture, short enough that nobody waits on one. */
const SCREENSHOT_TIMEOUT_MS = 5_000
/** The tools after which the page has likely changed, and a fresh look is worth taking. */
const CHANGES_PAGE = new Set([
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_switch_tab',
  'browser_go_back',
])

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
  private profile: BrowserProfile | undefined

  constructor(private readonly options: BrowserUseOptions = {}) {}

  /** The profile in use, once connected. `shared` says whether it is the user's own. */
  get browserProfile(): BrowserProfile | undefined {
    return this.profile
  }

  async connect(): Promise<void> {
    this.profile = await createBrowserProfile({
      dir: this.options.profileDir,
      base: this.options.profileBase,
      keep: this.options.keepProfile,
    })

    this.client = await spawnMcpServer({
      command: this.options.command ?? 'python3',
      args: this.options.args ?? ['-m', 'browser_use.mcp'],
      // Profile variables first, so an explicit `env` entry still wins: an
      // operator naming a variable by hand has said something more specific
      // than our default.
      env: {
        ...profileEnv(this.profile, this.options.profileEnvVars ?? DEFAULT_PROFILE_ENV_VARS),
        ...this.options.env,
      },
      allowEnv: this.options.allowEnv,
      clientName: 'open-agent',
    })
  }

  async tools(): Promise<ToolDefinition[]> {
    if (!this.client) throw new Error('call connect() before tools()')
    const client = this.client
    const descriptors = await client.listTools()
    const timeoutMs = this.options.screenshotTimeoutMs ?? SCREENSHOT_TIMEOUT_MS
    const canWatch = this.options.liveView !== false && descriptors.some((d) => d.name === SCREENSHOT_TOOL)
    return descriptors.map((descriptor) => {
      const tool = mcpToolDefinition(client, descriptor, PERMISSION_OVERRIDES[descriptor.name] ?? 'safe')
      if (!canWatch || !CHANGES_PAGE.has(descriptor.name)) return tool
      return {
        ...tool,
        async execute(args, context) {
          const result = await tool.execute(args, context)
          if (result.ok && context.onAttachment) {
            await showPage(client, context, `after ${descriptor.name}`, timeoutMs)
          }
          return result
        },
      }
    })
  }

  close(): void {
    this.client?.close()
  }

  /** Closes the subprocess and removes a provisioned profile. */
  async dispose(): Promise<void> {
    this.close()
    await this.profile?.dispose()
    this.profile = undefined
  }
}

/**
 * Takes a screenshot for whoever is watching. A side call the model never
 * made and never sees: nothing of it is logged or returned, and a failure
 * to take it is dropped rather than failing the action it follows.
 */
async function showPage(
  client: McpStdioClient,
  context: ToolExecutionContext,
  caption: string,
  timeoutMs: number,
): Promise<void> {
  try {
    // Bounded: the action it follows has already finished, and a slow or
    // stuck screenshot must not hold the task up waiting for a picture.
    const shot = await Promise.race([
      client.callTool(SCREENSHOT_TOOL, {}),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('screenshot timed out')), timeoutMs).unref(),
      ),
    ])
    for (const attachment of imageAttachments(shot, caption)) context.onAttachment?.(attachment)
  } catch {
    // The page is shown on the next action that changes it.
  }
}

/**
 * Connects to browser-use and registers every tool it exposes on the given
 * registry (e.g. `ctx.get('tools')`). Returns a disposer that unregisters
 * them and closes the underlying MCP subprocess.
 */
export async function mountBrowserUseTools(registry: ToolRegistry, options: BrowserUseOptions = {}): Promise<Disposer> {
  const browserUse = new BrowserUseTools(options)
  await browserUse.connect()
  const unregisterFns = (await browserUse.tools()).map((tool) => registry.register(tool))
  return () => {
    for (const unregister of unregisterFns) unregister()
    // The disposer is synchronous by contract, so the profile removal is
    // started and not waited on. A leftover directory in the temp dir is a
    // far smaller problem than a disposer that cannot be called from one.
    void browserUse.dispose()
  }
}

export function withContext(ctx: Context, options: BrowserUseOptions = {}): Promise<Disposer> {
  const registry = ctx.get<ToolRegistry>('tools')
  if (!registry) throw new Error('ctx.tools is not mounted — install toolsPlugin from @open-agent/agent first')
  return mountBrowserUseTools(registry, options)
}

/**
 * A Context plugin that wires up browser-use tools. It declares an inject
 * dependency on 'tools' so it waits for the ToolRegistry to exist, then
 * spawns the MCP server and registers its tools as a background effect.
 */
export function browserToolsPlugin(options: BrowserUseOptions = {}): Plugin {
  return {
    inject: ['tools'],
    apply(ctx: Context) {
      const registry = ctx.get<ToolRegistry>('tools')!
      let dispose: Disposer | undefined
      let disposed = false
      mountBrowserUseTools(registry, options)
        .then((unmount) => {
          dispose = unmount
          if (disposed) unmount()
        })
        .catch((err) => {
          console.error('[browser-use] failed to mount MCP tools:', err instanceof Error ? err.message : String(err))
        })
      return () => {
        disposed = true
        if (dispose) dispose()
      }
    },
  }
}
