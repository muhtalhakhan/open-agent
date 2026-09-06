#!/usr/bin/env -S npx tsx
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import dotenv from 'dotenv'
import {
  AgentLoop,
  SessionLog,
  ToolRegistry,
  buildSystemPrompt,
  consoleLogger,
  loadProjectInstructions,
  silentLogger,
} from '@open-agent/agent'
import { InMemoryMemoryProvider, Mem0Provider, SupermemoryProvider, memoryPlugin } from '@open-agent/memory'
import type { MemoryProvider } from '@open-agent/memory'
import { OpenAiCompatibleProvider, createRedactingLogger } from '@open-agent/providers'
import { mountBrowserUseTools } from '@open-agent/tools-browser'
import { createSessionWorkspace, mountFileTools, openWorkspace, type Workspace } from '@open-agent/tools-files'
import { httpRequestTool } from '@open-agent/tools-http'
import { mountTerminalTools, selectSandbox } from '@open-agent/tools-terminal'
import { BraveSearchProvider, TavilySearchProvider, webSearchTool } from '@open-agent/tools-search'
import { Context } from '@open-agent/context'
import { loadConfigFromEnv } from './config.js'
import { createNonInteractiveApprovalHandler, createTerminalApprovalHandler } from './approval.js'
import { parseCliArgs, USAGE } from './args.js'
import { runHeadless } from './headless.js'
import { runRepl, type AbortRef, type ReplIO } from './repl.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// apps/cli/src -> apps/cli -> apps -> repo root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') })

/**
 * The Ink TUI needs a real TTY on both ends to take over the screen. Fall
 * back to the plain readline REPL for anything else (CI, `| cat`, piped
 * input/output, etc) — set `CLI_NO_TUI=1` to force the fallback locally
 * (in the shell or in `.env`, since dotenv has already loaded above).
 */
const ttyBothEnds = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !process.env.CLI_NO_TUI

/** Reads the whole of stdin, for `echo "task" | open-agent -p`. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

async function main() {
  const parsedArgs = parseCliArgs(process.argv.slice(2))
  if (!parsedArgs.ok) {
    console.error(parsedArgs.error)
    process.exitCode = 1
    return
  }
  const args = parsedArgs.args
  if (args.help) {
    console.log(USAGE)
    return
  }
  const headless = args.mode === 'print'
  const useTui = ttyBothEnds && !headless

  const result = loadConfigFromEnv(process.env)
  if (!result.ok) {
    console.error(result.error)
    process.exitCode = 1
    return
  }
  const { config } = result

  // Loaded before any stdin wiring, and deliberately so. An await that yields
  // to real I/O between createInterface() below and the first prompt gives
  // readline time to consume and discard piped input, so `echo task | cli`
  // prints the banner and exits having done nothing. Keep that window free of
  // I/O — cli.integration.test.ts pins the behaviour.
  const instructions = await loadProjectInstructions()

  const ctx = new Context()
  const sessions = new SessionLog()
  const tools = new ToolRegistry()
  const activeAbort: AbortRef = { current: null }

  let io: ReplIO
  let ask: (question: string) => Promise<string>
  let teardown: () => void

  if (headless) {
    // No readline, no TUI: stdin may carry the task itself, and stdout must
    // hold nothing but the answer. Everything chatty goes to stderr.
    io = {
      async prompt() {
        return null
      },
      write: (text) => void process.stderr.write(text),
    }
    ask = async () => 'n'
    teardown = () => {}
  } else if (useTui) {
    const { mountTui } = await import('./tui/mount.js')
    const tui = mountTui({
      onInterrupt: () => {
        if (activeAbort.current) {
          tui.io.setStatus('[cancelling current task...]')
          activeAbort.current.abort()
        } else {
          tui.unmount()
          process.exit(0)
        }
      },
    })
    io = tui.io
    ask = tui.io.ask
    teardown = () => tui.unmount()
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    io = {
      async prompt() {
        try {
          return await rl.question('> ')
        } catch {
          return null // readline closed (e.g. Ctrl+D)
        }
      },
      write: (text) => process.stdout.write(text),
    }
    ask = (question) => rl.question(question)
    process.on('SIGINT', () => {
      if (activeAbort.current) {
        console.log('\n[cancelling current task...]')
        activeAbort.current.abort()
      } else {
        rl.close()
        process.exit(0)
      }
    })
    teardown = () => rl.close()
  }

  // Surfaced on startup: a file that silently steers every turn is worth
  // naming. Reported relative to the repo root, not the cwd, so it reads as
  // `AGENTS.md` however deep the CLI was launched from.
  if (instructions) {
    io.write(
      `Loaded project conventions from ${path.relative(instructions.root, instructions.source)}` +
        `${instructions.truncated ? ' (truncated)' : ''}\n`,
    )
  }

  tools.onApproval(
    headless
      ? createNonInteractiveApprovalHandler(args.approveAsk, (msg) => void process.stderr.write(msg))
      : createTerminalApprovalHandler(ask),
  )

  let disposeBrowserTools: (() => void) | undefined
  if (config.browser.enabled) {
    // Via io.write, not console.log: in print mode that routes to stderr so
    // it cannot land in the captured answer.
    io.write('Starting browser-use (python -m browser_use.mcp)...\n')
    // A shared profile is a browser already logged into everything the user
    // is, reachable by any page the agent visits. Worth saying out loud when
    // someone has asked for it.
    io.write(
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
  let workspace: Workspace | undefined
  let disposeFileTools: (() => void) | undefined
  let disposeTerminalTools: (() => void) | undefined

  if (config.files.enabled || config.shell.enabled) {
    const policy = { deny: config.files.deny, allow: config.files.allow, readOnly: config.files.readOnly }
    workspace = config.workspace.session
      ? await createSessionWorkspace({ base: config.workspace.base, policy })
      : await openWorkspace({ root: config.files.root ?? config.shell.root ?? process.cwd(), policy })

    if (config.workspace.session) {
      io.write(`Working in a session workspace at ${workspace.root}\n`)
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
        io.write(
          `Shell tools are off: no sandbox is available (asked for "${config.shell.sandbox}").\n` +
            `Install bubblewrap or Docker, or set SHELL_SANDBOX=none to run commands with your own privileges.\n`,
        )
      } else {
        if (sandbox.name === 'none') {
          io.write('Shell tools are UNSANDBOXED: commands run with your full privileges.\n')
        } else {
          io.write(`Shell sandbox: ${sandbox.describe()}\n`)
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

  const llm = new OpenAiCompatibleProvider(config.llm)
  const loop = new AgentLoop({
    sessions,
    tools,
    llm,
    systemPrompt: instructions ? buildSystemPrompt(instructions) : undefined,
    // Wrapped so a resolved API key cannot reach the log through an
    // error body, a tool argument, or anything else that happens to carry it.
    logger: createRedactingLogger(process.env.DEBUG ? consoleLogger : silentLogger, config.secrets),
  })

  try {
    const memory = ctx.get<MemoryProvider>('memory')!
    const containerTag = process.env.CLI_USER_ID ?? 'cli-user'
    const memoryHook = { provider: memory, containerTag }

    if (headless) {
      if (args.prompt === undefined && process.stdin.isTTY) {
        console.error('No task given. Pass one as `-p "<task>"` or pipe it on stdin.')
        process.exitCode = 1
        return
      }
      const prompt = args.prompt ?? (await readStdin())
      const controller = new AbortController()
      activeAbort.current = controller
      process.on('SIGINT', () => controller.abort())
      process.exitCode = await runHeadless(loop, sessions, {
        prompt,
        io: {
          out: (text) => void process.stdout.write(text),
          err: (text) => void process.stderr.write(text),
        },
        signal: controller.signal,
        memory: memoryHook,
      })
    } else {
      await runRepl(loop, sessions, io, activeAbort, memoryHook)
    }
  } finally {
    teardown()
    disposeBrowserTools?.()
    // Before the workspace goes: a background process outlives the task that
    // started it, and a session workspace is about to be deleted out from
    // under anything still running in it.
    disposeTerminalTools?.()
    disposeFileTools?.()
    await workspace?.dispose()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
