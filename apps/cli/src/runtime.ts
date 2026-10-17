import { AgentLoop, consoleLogger, silentLogger, type SessionLog, type ToolRegistry } from '@open-agent/agent'
import { Context } from '@open-agent/context'
import { InMemoryMemoryProvider, Mem0Provider, SupermemoryProvider, memoryPlugin } from '@open-agent/memory'
import type { MemoryProvider } from '@open-agent/memory'
import { JevDecisionModel, OpenAiCompatibleProvider, createRedactingLogger } from '@open-agent/providers'
import { mountBrowserUseTools } from '@open-agent/tools-browser'
import {
  computerUseTaskTool,
  computerScreenshotTool,
  createNutJsScreenshotOperator,
  createUiTarsGuiAgentFactory,
} from '@open-agent/tools-computer'
import { createSessionWorkspace, mountFileTools, openWorkspace, type Workspace } from '@open-agent/tools-files'
import { httpRequestTool } from '@open-agent/tools-http'
import { BraveSearchProvider, TavilySearchProvider, webSearchTool } from '@open-agent/tools-search'
import { mountDecisionTools } from '@open-agent/tools-decision'
import { mountTerminalTools, selectSandbox } from '@open-agent/tools-terminal'
import type { CliConfig } from './config.js'

export interface RuntimeOptions {
  config: CliConfig
  sessions: SessionLog
  /** Already carrying the approval policy and any host-specific tools (takeover, say); the config's tools join it. */
  tools: ToolRegistry
  /** Startup notices — which tools loaded, whether the shell is sandboxed. */
  write: (text: string) => void
  /** The workspace root when the config names none. */
  cwd: string
  systemPrompt?: string
  /** Log the loop's progress to the console (still redacted). */
  debug?: boolean
}

export interface Runtime {
  loop: AgentLoop
  memory: MemoryProvider
  /** Stops what the tools started and removes a session workspace. Call once the last task has finished. */
  dispose(): Promise<void>
}

/**
 * Everything the configuration turns on — tools, memory, the model — wired
 * into one agent loop. Shared by every way of driving it (the REPL, print
 * mode, the web UI) so a tool cannot be available in one and missing, or
 * differently sandboxed, in another.
 *
 * What differs between those hosts stays with them: who answers an approval,
 * whether a person can take the wheel, how output reaches the user.
 */
export async function createRuntime({
  config,
  sessions,
  tools,
  write,
  cwd,
  systemPrompt,
  debug = false,
}: RuntimeOptions): Promise<Runtime> {
  let disposeBrowserTools: (() => void) | undefined
  let workspace: Workspace | undefined
  let disposeFileTools: (() => void) | undefined
  let disposeTerminalTools: (() => void) | undefined
  let disposeDecisionTools: (() => void) | undefined

  const dispose = async () => {
    disposeDecisionTools?.()
    disposeBrowserTools?.()
    // Before the workspace goes: a background process outlives the task that
    // started it, and a session workspace is about to be deleted out from
    // under anything still running in it.
    disposeTerminalTools?.()
    disposeFileTools?.()
    await workspace?.dispose()
  }

  try {
    // --- Computer-use tools (UI-TARS: screenshot + full mouse/keyboard loop) ---
    if (config.computer.enabled) {
      const factory = createUiTarsGuiAgentFactory({
        model: {
          // Same endpoint and key as the main LLM; COMPUTER_USE_MODEL only
          // swaps the model, since UI-TARS wants a vision-capable one.
          baseURL: config.llm.baseURL,
          apiKey: config.llm.apiKey,
          model: config.computer.model ?? config.llm.model,
        },
      })
      tools.register(computerUseTaskTool(factory))
      tools.register(computerScreenshotTool(createNutJsScreenshotOperator()))
      write('Computer-use tools loaded (COMPUTER_USE=1).\n')
    }
    if (config.browser.enabled) {
      write('Starting browser-use (python -m browser_use.mcp)...\n')
      // A shared profile is a browser already logged into everything the user
      // is, reachable by any page the agent visits. Worth saying out loud when
      // someone has asked for it.
      write(
        config.browser.profileDir
          ? `Browser profile: ${config.browser.profileDir} (SHARED — the agent gets any session logged in there)\n`
          : 'Browser profile: a throwaway one, discarded when this run ends\n',
      )
      disposeBrowserTools = await mountBrowserUseTools(tools, {
        profileDir: config.browser.profileDir,
        keepProfile: config.browser.keepProfile,
        allowEnv: config.browser.allowEnv,
      })
    }

    // One workspace for the file and shell tools alike: the capability the user
    // granted is "this directory", not "this directory for reads and some other
    // one for commands". `WORKSPACE_SESSION=1` provisions a throwaway directory
    // per run instead, which is what keeps two concurrent agents out of each
    // other's files.
    if (config.files.enabled || config.shell.enabled) {
      const policy = { deny: config.files.deny, allow: config.files.allow, readOnly: config.files.readOnly }
      workspace = config.workspace.session
        ? await createSessionWorkspace({ base: config.workspace.base, policy })
        : await openWorkspace({ root: config.files.root ?? config.shell.root ?? cwd, policy })

      if (config.workspace.session) {
        write(`Working in a session workspace at ${workspace.root}\n`)
      }
      if (config.files.enabled) disposeFileTools = mountFileTools(tools, workspace)

      if (config.shell.enabled) {
        const sandbox = await selectSandbox(config.shell.sandbox, {
          docker: { image: config.shell.sandboxImage },
        })

        // Not registering the tools is the whole point of the check. Falling
        // back to an unsandboxed shell because bwrap happened to be missing is
        // exactly the failure the sandbox exists to prevent, so the shell stays
        // off until someone says which of the two they want.
        if (!sandbox) {
          write(
            `Shell tools are off: no sandbox is available (asked for "${config.shell.sandbox}").\n` +
              `Install bubblewrap or Docker, or set SHELL_SANDBOX=none to run commands with your own privileges.\n`,
          )
        } else {
          if (sandbox.name === 'none') {
            write('Shell tools are UNSANDBOXED: commands run with your full privileges.\n')
          } else {
            write(`Shell sandbox: ${sandbox.describe()}\n`)
          }
          disposeTerminalTools = mountTerminalTools(tools, workspace, {
            allowedCommands: config.shell.allowedCommands,
            allowEnv: config.shell.allowEnv,
            timeoutMs: config.shell.timeoutMs,
            sandbox,
            network: config.shell.network,
          })
        }
      }
    }

    if (config.http.enabled) {
      tools.register(
        httpRequestTool({
          allowedHosts: config.http.allowedHosts,
          network: { deniedHosts: config.http.deniedHosts, allowLocal: config.http.allowLocal },
          secrets: config.http.secrets,
        }),
      )
    }

    if (config.search.provider !== 'none') {
      const searchProvider =
        config.search.provider === 'brave'
          ? new BraveSearchProvider({ apiKey: config.search.apiKey })
          : new TavilySearchProvider({ apiKey: config.search.apiKey })
      tools.register(webSearchTool(searchProvider))
    }

    if (config.decision.provider === 'jev') {
      const decisionModel = new JevDecisionModel(config.decision)
      const destination = new URL(config.decision.baseURL ?? 'https://api.typesafe.ai').host
      disposeDecisionTools = mountDecisionTools(tools, decisionModel, { destination })
      // Named, since what the model passes these tools leaves the machine.
      write(`Decision tools loaded: classify, check, rank and score, answered by Jev at ${destination}.\n`)
    }

    const ctx = new Context()
    if (config.memory.provider === 'supermemory') {
      const { default: Supermemory } = await import('supermemory')
      ctx.plugin(
        memoryPlugin(
          new SupermemoryProvider(new Supermemory({ apiKey: config.memory.apiKey, baseURL: config.memory.baseURL })),
        ),
      )
    } else if (config.memory.provider === 'mem0') {
      const { default: MemoryClient } = await import('mem0ai')
      ctx.plugin(memoryPlugin(new Mem0Provider(new MemoryClient({ apiKey: config.memory.apiKey }))))
    } else {
      ctx.plugin(memoryPlugin(new InMemoryMemoryProvider()))
    }

    const loop = new AgentLoop({
      sessions,
      tools,
      llm: new OpenAiCompatibleProvider(config.llm),
      systemPrompt,
      // Wrapped so a resolved API key cannot reach the log through an
      // error body, a tool argument, or anything else that happens to carry it.
      logger: createRedactingLogger(debug ? consoleLogger : silentLogger, config.secrets),
    })

    return { loop, memory: ctx.get<MemoryProvider>('memory')!, dispose }
  } catch (err) {
    // A browser that started before the shell sandbox check threw would
    // otherwise outlive the process that can no longer reach it.
    await dispose()
    throw err
  }
}
