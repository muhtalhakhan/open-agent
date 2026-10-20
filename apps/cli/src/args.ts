import { parseArgs } from 'node:util'

export interface CliArgs {
  /**
   * `print` runs one task and exits; `repl` is the interactive session; `init`
   * writes `.env`; `web` serves the chat UI in a browser.
   */
  mode: 'repl' | 'print' | 'init' | 'web'
  /** The task, in print mode. Undefined means "read it from stdin". */
  prompt?: string
  /** Approve `ask`-level tool calls automatically, since no human is present. */
  approveAsk: boolean
  /** Review file edits as a diff before they run (interactive sessions). */
  plan: boolean
  /** If `repl`, resume the most recent (or named) session instead of starting fresh. */
  resume?: string | true
  /** Print recent past tasks and exit. */
  history: boolean
  help: boolean
  /** The local port `web` listens on. */
  port?: number
}

/** Fixed rather than random so the Vite dev server's proxy knows where to find it; `--port` moves it. */
export const DEFAULT_WEB_PORT = 7373

export type ArgsResult = { ok: true; args: CliArgs } | { ok: false; error: string }

export const USAGE = `open-agent — an agent you can run from your terminal

Usage
  open-agent                     start the interactive session
  open-agent init                set up the provider, key and tools, and write .env
  open-agent web                 chat with the agent in your browser
  open-agent -p "<task>"         run one task, print the result, exit
  echo "<task>" | open-agent -p  same, reading the task from stdin
  open-agent --resume            reopen the most recent session
  open-agent --resume <id>       reopen a specific session by id
  open-agent --history           list recent tasks from past sessions

Options
  -p, --print [task]   non-interactive: run a single task and exit
  -y, --yes            approve "ask"-level tool calls without prompting
  --plan               review file edits as a diff before they run (interactive sessions)
  --resume [id]        resume the most recent or named session
  --profile <name>     load an agent profile before starting
  --history            list recent past tasks and exit
  --port <n>           the local port for \`open-agent web\` (default ${DEFAULT_WEB_PORT})
  -h, --help           show this help

In the interactive session
  :history             list recent tasks, this session's included
  :bg <task>           run a task in the background and keep working
  :jobs                list background jobs; :job <id> shows one in full
  :cancel <id>         cancel a background job
  :exit                quit (cancels unfinished background jobs)

Background jobs cannot stop to ask for approval, so "ask"-level tool
calls in them are denied unless the session was started with --yes.
The web UI asks in the browser, with the same choices as the terminal.

Exit codes (print mode)
  0  the task completed
  1  the task failed
  130  the task was cancelled (Ctrl+C)

In print mode only the final answer goes to stdout; progress and
diagnostics go to stderr, so \`open-agent -p "..." > out.txt\` captures
just the answer.`

/**
 * Pure argv -> CliArgs parsing, kept separate from index.ts so it can be
 * tested without touching real argv, the same way config.ts is.
 *
 * `-p` takes an optional value: `-p "task"` supplies the task inline, while a
 * bare `-p` means the task arrives on stdin. node:util's parseArgs has no
 * optional-value support, so `-p` is declared boolean and the task is taken
 * from the first positional instead.
 */
export function parseCliArgs(argv: string[]): ArgsResult {
  const options = {
    print: { type: 'boolean', short: 'p', default: false },
    yes: { type: 'boolean', short: 'y', default: false },
    plan: { type: 'boolean', default: false },
    resume: { type: 'string' },
    history: { type: 'boolean', default: false },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  } as const

  let positionals: string[]
  let values: {
    print: boolean
    yes: boolean
    plan: boolean
    resume?: string | undefined
    history: boolean
    port?: string | undefined
    help: boolean
    profile?: string | undefined
  }
  try {
    const parsed = parseArgs({ args: argv, options, allowPositionals: true })
    values = parsed.values as {
      print: boolean
      yes: boolean
      plan: boolean
      resume?: string | undefined
      history: boolean
      port?: string | undefined
      help: boolean
      profile?: string | undefined
    }
    positionals = parsed.positionals
  } catch (err) {
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)}\n\n${USAGE}` }
  }
  if (values.help) {
    return {
      ok: true,
      args: {
        mode: 'repl',
        approveAsk: false,
        plan: false,
        resume: undefined,
        history: false,
        help: true,
        profile: undefined,
      },
    }
  }
  if (values.history) {
    return {
      ok: true,
      args: {
        mode: 'repl',
        approveAsk: false,
        plan: false,
        resume: undefined,
        history: true,
        help: false,
        profile: undefined,
      },
    }
  }

  // parseArgs always returns a string for `resume`. Treat `--resume` (no value)
  // as `true` (resume most recent) by leaving the value undefined; treat a
  // bare token after `--resume` as that session id.
  const resumeValue: string | true | undefined =
    values.resume === undefined ? undefined : values.resume === '' ? true : values.resume

  const isWeb = !values.print && positionals.length === 1 && positionals[0] === 'web'
  if (values.port !== undefined && !isWeb) {
    return { ok: false, error: '--port only applies to `open-agent web`.' }
  }

  if (isWeb) {
    const port = values.port === undefined ? DEFAULT_WEB_PORT : Number(values.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: `--port must be a number from 1 to 65535, not "${values.port}".` }
    }
    return {
      ok: true,
      args: {
        mode: 'web',
        approveAsk: values.yes,
        plan: values.plan,
        resume: resumeValue,
        history: false,
        help: false,
        port,
      },
    }
  }

  if (!values.print) {
    // A word rather than a flag: it is a different program from the session,
    // and `-p init` still means "run the task called init".
    if (positionals.length === 1 && positionals[0] === 'init') {
      return {
        ok: true,
        args: {
          mode: 'init',
          approveAsk: false,
          plan: false,
          resume: undefined,
          history: false,
          help: false,
          profile: undefined,
        },
      }
    }
    if (positionals.length > 0) {
      return { ok: false, error: `Unexpected argument "${positionals[0]}". Did you mean -p "${positionals[0]}"?` }
    }
    return {
      ok: true,
      args: {
        mode: 'repl',
        approveAsk: values.yes,
        plan: values.plan,
        resume: resumeValue,
        history: false,
        help: false,
        profile: values.profile,
      },
    }
  }

  if (positionals.length > 1) {
    return { ok: false, error: 'Pass the task as a single argument, e.g. -p "run the tests".' }
  }

  return {
    ok: true,
    args: {
      mode: 'print',
      prompt: positionals[0],
      approveAsk: values.yes,
      plan: values.plan,
      resume: resumeValue,
      history: false,
      help: false,
      profile: values.profile,
    },
  }
}
