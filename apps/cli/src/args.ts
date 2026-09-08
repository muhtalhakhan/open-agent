import { parseArgs } from 'node:util'

export interface CliArgs {
  /** `print` runs one task and exits; `repl` is the interactive session. */
  mode: 'repl' | 'print'
  /** The task, in print mode. Undefined means "read it from stdin". */
  prompt?: string
  /** Approve `ask`-level tool calls automatically, since no human is present. */
  approveAsk: boolean
  /** If `repl`, resume the most recent (or named) session instead of starting fresh. */
  resume?: string | true
  help: boolean
}

export type ArgsResult = { ok: true; args: CliArgs } | { ok: false; error: string }

export const USAGE = `open-agent — an agent you can run from your terminal

Usage
  open-agent                     start the interactive session
  open-agent -p "<task>"         run one task, print the result, exit
  echo "<task>" | open-agent -p  same, reading the task from stdin
  open-agent --resume            reopen the most recent session
  open-agent --resume <id>       reopen a specific session by id

Options
  -p, --print [task]   non-interactive: run a single task and exit
  -y, --yes            approve "ask"-level tool calls without prompting
  --resume [id]        resume the most recent or named session
  -h, --help           show this help

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
    resume: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  } as const

  let positionals: string[]
  let values: { print: boolean; yes: boolean; resume?: string | undefined; help: boolean }
  try {
    const parsed = parseArgs({ args: argv, options, allowPositionals: true })
    values = parsed.values as { print: boolean; yes: boolean; resume?: string | undefined; help: boolean }
    positionals = parsed.positionals
  } catch (err) {
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)}\n\n${USAGE}` }
  }
  if (values.help) return { ok: true, args: { mode: 'repl', approveAsk: false, resume: undefined, help: true } }

  // parseArgs always returns a string for `resume`. Treat `--resume` (no value)
  // as `true` (resume most recent) by leaving the value undefined; treat a
  // bare token after `--resume` as that session id.
  const resumeValue: string | true | undefined =
    values.resume === undefined ? undefined : values.resume === '' ? true : values.resume

  if (!values.print) {
    if (positionals.length > 0) {
      return { ok: false, error: `Unexpected argument "${positionals[0]}". Did you mean -p "${positionals[0]}"?` }
    }
    return { ok: true, args: { mode: 'repl', approveAsk: values.yes, resume: resumeValue, help: false } }
  }

  if (positionals.length > 1) {
    return { ok: false, error: 'Pass the task as a single argument, e.g. -p "run the tests".' }
  }

  return {
    ok: true,
    args: { mode: 'print', prompt: positionals[0], approveAsk: values.yes, resume: resumeValue, help: false },
  }
}
