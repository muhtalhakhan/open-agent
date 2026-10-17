#!/usr/bin/env -S npx tsx
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import dotenv from 'dotenv'
import {
  LeaseManager,
  SessionLog,
  SessionStore,
  ToolRegistry,
  buildSystemPrompt,
  loadProjectInstructions,
  readTaskHistory,
} from '@open-agent/agent'
import { OpenAiCompatibleProvider } from '@open-agent/providers'
import { mountTakeoverTools } from '@open-agent/tools-computer'
import { KeychainSecretStore } from '@open-agent/security'
import { startWebServer, type WebServer } from '@open-agent/web'
import { loadConfigFromEnv } from './config.js'
import { runInit, type KeychainWriter } from './init.js'
import { createTerminalInitIO } from './init-io.js'
import {
  createNonInteractiveApprovalHandler,
  createPlanApprovalHandler,
  createRoutingApprovalHandler,
  createTerminalApprovalHandler,
} from './approval.js'
import { createBackgroundJobs, type BackgroundJobs } from './background.js'
import { DEFAULT_WEB_PORT, parseCliArgs, USAGE } from './args.js'
import { runHeadless } from './headless.js'
import { describeUnreadable, formatHistory, sessionHistory } from './history.js'
import { createTerminalAnswerStream, type AnswerStream } from './answer-stream.js'
import { renderMarkdown, shouldRenderMarkdown } from './markdown.js'
import { createLineActivityView, type ToolActivityView } from './tool-activity.js'
import { createApprovalAsk, createLineReader } from './line-reader.js'
import { createTerminalTakeoverHandler } from './takeover.js'
import { runRepl, type AbortRef, type ReplIO } from './repl.js'
import { createRuntime } from './runtime.js'
import { executeTask } from './task.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// apps/cli/src -> apps/cli -> apps -> repo root
const ENV_PATH = path.resolve(__dirname, '../../../.env')
dotenv.config({ path: ENV_PATH })

/** How long `init` waits for the model to answer its one test request. */
const INIT_CHECK_TIMEOUT_MS = 30_000

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
  // Before the config is read, since writing one is the point.
  if (args.mode === 'init') {
    const io = createTerminalInitIO(process.stdin, process.stdout)
    let keychain: KeychainWriter | undefined
    try {
      keychain = new KeychainSecretStore()
    } catch {
      // No keychain tool for this platform; keys go in .env.
    }
    try {
      process.exitCode = await runInit(io, {
        envPath: ENV_PATH,
        exists: existsSync,
        writeEnv(file, content) {
          writeFileSync(file, content, { mode: 0o600 })
          // `mode` applies only to a file being created; one being replaced
          // keeps whatever permissions it had.
          chmodSync(file, 0o600)
        },
        async check(llm) {
          try {
            await new OpenAiCompatibleProvider(llm).generate(
              { messages: [{ role: 'user', content: 'Reply with the word OK.' }], tools: [] },
              AbortSignal.timeout(INIT_CHECK_TIMEOUT_MS),
            )
            return undefined
          } catch (err) {
            return err instanceof Error ? err.message : String(err)
          }
        },
        keychain,
        cwd: process.cwd(),
      })
    } finally {
      io.close()
    }
    return
  }
  // Before the provider config is read: looking at past tasks needs no API
  // key, and refusing to show them for want of one would be absurd.
  if (args.history) {
    const records = await readTaskHistory(new SessionStore(), {
      onUnreadable: (id, err) => void process.stderr.write(describeUnreadable(id, err)),
    })
    process.stdout.write(formatHistory(records))
    return
  }
  const headless = args.mode === 'print'
  // The person is in a browser, not at this terminal: nothing here prompts.
  const web = args.mode === 'web'
  const useTui = ttyBothEnds && !headless && !web

  const result = loadConfigFromEnv(process.env)
  if (!result.ok) {
    console.error(result.error)
    process.exitCode = 1
    return
  }
  const { config } = result

  const instructions = await loadProjectInstructions()

  // Handle session resume: load existing session log if --resume is given
  const sessionStore = new SessionStore()
  const sessions = new SessionLog()
  let resumedSessionId: string | undefined
  let resumedTaskId: string | undefined

  if (args.resume !== undefined) {
    let sessionId: string | null = args.resume === true ? null : args.resume
    if (sessionId === null) {
      sessionId = await sessionStore.mostRecent()
      if (!sessionId) {
        console.error('No prior sessions found to resume.')
        process.exitCode = 1
        return
      }
    }

    const stored = await sessionStore.load(sessionId)
    if (!stored) {
      console.error(`Session "${sessionId}" not found.`)
      process.exitCode = 1
      return
    }

    // Find the most recent task ID in the stored events
    const taskIds = new Set<string>()
    for (const event of stored.events) {
      if (event.taskId) taskIds.add(event.taskId)
    }
    const taskIdArray = Array.from(taskIds)
    if (taskIdArray.length === 0) {
      console.error(`Session "${sessionId}" has no tasks to resume.`)
      process.exitCode = 1
      return
    }
    // Use the most recent task ID
    resumedTaskId = taskIdArray[taskIdArray.length - 1]
    resumedSessionId = sessionId

    // Load all events into the session log
    sessions.loadFrom(stored)
  }

  const tools = new ToolRegistry()
  const activeAbort: AbortRef = { current: null }

  let io: ReplIO
  let webServer: WebServer | undefined
  const pendingNotices: string[] = []
  let ask: (question: string) => Promise<string>
  let teardown: () => void
  // Print mode has no stream: stdout is the answer alone, and a script that
  // captured half a reply could not be told to take it back.
  let answerStream: (() => AnswerStream) | undefined
  let toolActivity: ToolActivityView | undefined
  const markdown = shouldRenderMarkdown(process.stdout.isTTY, process.env)

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
  } else if (web) {
    // Printed for whoever started the server and passed on to the browser:
    // "the shell is unsandboxed" matters most to the person about to give the
    // agent a task. Held until the server is up to receive it.
    io = {
      async prompt() {
        return null
      },
      write: (text) => {
        process.stdout.write(text)
        if (webServer) webServer.notice(text)
        else pendingNotices.push(text)
      },
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
          // Ends the session the way :exit does, so background jobs are
          // stopped and the session saved rather than lost to process.exit.
          tui.io.end()
        }
      },
    })
    io = tui.io
    ask = tui.io.ask
    answerStream = () => tui.io.answerStream(markdown ? renderMarkdown : undefined)
    toolActivity = tui.io.toolActivity()
    teardown = () => tui.unmount()
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    // Subscribed before anything else can yield: every line is queued from the
    // moment the interface exists, so none is emitted to nobody however long
    // startup takes. See line-reader.ts.
    const reader = createLineReader(rl)
    io = {
      prompt: () => reader.next('> '),
      write: (text) => process.stdout.write(text),
    }
    answerStream = () => createTerminalAnswerStream((text) => void process.stdout.write(text), { markdown })
    toolActivity = createLineActivityView((text) => void process.stdout.write(text), { color: markdown })
    // The same reader, deliberately: two on one stdin would race each other.
    ask = createApprovalAsk(reader, Boolean(process.stdin.isTTY))
    process.on('SIGINT', () => {
      if (activeAbort.current) {
        console.log('\n[cancelling current task...]')
        activeAbort.current.abort()
      } else {
        // Closing readline ends input like Ctrl+D; the session then winds
        // down as :exit does instead of dying with its jobs unsaved.
        rl.close()
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

  // Plan mode needs a human to review the diff, so it is interactive-only.
  // Failing loudly beats silently treating --plan as a no-op in a CI job.
  if (headless && args.plan) {
    console.error(
      '--plan is interactive-only: a file edit needs a human to review its diff, so it has no meaning in print mode.',
    )
    process.exitCode = 1
    return
  }
  if (web && args.plan) {
    console.error('--plan needs a diff review the web UI does not have yet (#109). Use it in the terminal.')
    process.exitCode = 1
    return
  }

  // Background jobs exist only in the interactive session, and only once the
  // agent loop does; the router asks whichever set is live at call time.
  let background: BackgroundJobs | undefined
  tools.setUnattended((taskId) => background?.owns(taskId) ?? false)
  if (headless) {
    tools.onApproval(createNonInteractiveApprovalHandler(args.approveAsk, (msg) => void process.stderr.write(msg)))
  } else if (web) {
    // Until the web UI can ask (#109), it answers as print mode does, and
    // says so in the chat.
    tools.onApproval(createNonInteractiveApprovalHandler(args.approveAsk, (msg) => io.write(msg)))
  } else {
    tools.onApproval(
      createRoutingApprovalHandler(
        (taskId) => background?.owns(taskId) ?? false,
        args.plan
          ? createPlanApprovalHandler(ask, (text) => io.write(text), { color: !useTui })
          : createTerminalApprovalHandler(ask),
        createNonInteractiveApprovalHandler(args.approveAsk, (msg) => io.write(`[background] ${msg}`)),
      ),
    )
  }
  if (args.plan) {
    tools.enablePlans()
    io.write(`Plan mode: file edits are shown as a diff and reviewed before they run.\n`)
  }

  // Handing the wheel to a person needs a person at this machine's screen, so
  // these exist in an interactive terminal session and not in print mode or
  // the web UI, which has no way to offer the handoff yet. Not gated on
  // COMPUTER_USE: a login wall is met by the browser tools far more often than
  // by the computer ones, and the answer to it is the same handoff either way.
  let disposeTakeoverTools: (() => void) | undefined
  if (!headless && !web) {
    const leases = new LeaseManager({
      sessions,
      handler: createTerminalTakeoverHandler(ask),
      // A background job has nobody watching it; asking one to hand over
      // would wait on a person who never arrives.
      isUnattended: (taskId) => background?.owns(taskId) ?? false,
    })
    disposeTakeoverTools = mountTakeoverTools(tools, leases)
  }

  const runtime = await createRuntime({
    config,
    sessions,
    tools,
    // Via io.write, not console.log: in print mode that routes to stderr so
    // a startup notice cannot land in the captured answer.
    write: (text) => io.write(text),
    cwd: process.cwd(),
    systemPrompt: instructions ? buildSystemPrompt(instructions) : undefined,
    debug: Boolean(process.env.DEBUG),
  })
  const loop = runtime.loop

  try {
    const containerTag = process.env.CLI_USER_ID ?? 'cli-user'
    const memoryHook = { provider: runtime.memory, containerTag }

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
    } else if (web) {
      const port = args.port ?? DEFAULT_WEB_PORT
      try {
        webServer = await startWebServer({
          port,
          runTask: (input, signal, { onText, onEvent }) =>
            executeTask(loop, sessions, input, signal, { memory: memoryHook, onText, onEvent }),
          // The same sources as `:history`: saved sessions, plus this one,
          // whose tasks are only on disk once the server stops.
          history: {
            list: () =>
              sessionHistory(sessionStore, sessions, {
                limit: 50,
                onUnreadable: (id, err) => void process.stderr.write(describeUnreadable(id, err)),
              }),
            events: async (taskId, sessionId) =>
              sessionId === undefined ? sessions.all(taskId) : (await sessionStore.load(sessionId))?.events,
          },
        })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
        console.error(`Port ${port} is already in use. Pick another with --port.`)
        process.exitCode = 1
        return
      }
      for (const text of pendingNotices.splice(0)) webServer.notice(text)
      console.log(`\nOpenAgent web UI: ${webServer.url}\nOpen it in your browser. Ctrl+C stops the server.\n`)
      // Once, so a second Ctrl+C falls through to the default and kills a
      // shutdown that is stuck waiting on a task.
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve)
        process.once('SIGTERM', resolve)
      })
      // Waits out a running task, so what it did is in the session saved below.
      await webServer.close()
    } else {
      background = createBackgroundJobs(loop, sessions, (text) => io.write(text))
      await runRepl(loop, sessions, io, activeAbort, {
        memory: memoryHook,
        background,
        history: () =>
          sessionHistory(sessionStore, sessions, { onUnreadable: (id, err) => io.write(describeUnreadable(id, err)) }),
        formatAnswer: markdown ? renderMarkdown : undefined,
        answerStream,
        toolActivity,
      })
      // Before the session is saved, so what the jobs did so far is in it.
      const stopped = await background.close()
      if (stopped > 0) io.write(`Cancelled ${stopped} unfinished background job${stopped === 1 ? '' : 's'}.\n`)
    }

    // Persist session events to disk
    if (resumedSessionId !== undefined && resumedTaskId !== undefined) {
      await sessionStore.save(resumedSessionId, sessions.allEvents(), Date.now())
    } else {
      const sessionId = SessionStore.generateId()
      await sessionStore.save(sessionId, sessions.allEvents(), Date.now())
      if (!headless) {
        io.write(`Session ID: ${sessionId}\nUse 'open-agent --resume ${sessionId}' to resume this session.\n`)
      }
    }
  } finally {
    // Idempotent; covers the path where the session ended by throwing.
    await background?.close()
    teardown()
    disposeTakeoverTools?.()
    await runtime.dispose()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
