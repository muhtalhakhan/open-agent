import { parseArgs } from 'node:util'

export interface CliArgs {
  /** `print` runs one task and exits; `repl` is the interactive session. */
  mode: 'repl' | 'print'
  /** The task, in print mode. Undefined means "read it from stdin". */
  prompt?: string
  /** Approve `ask`-level tool calls automatically, since no human is present. */
  approveAsk: boolean
  help: boolean
}

export type ArgsResult = { ok: true; args: CliArgs } | { ok: false; error: string }

export const USAGE = `open-agent — an agent you can run from your terminal

Usage
  open-agent                     start the interactive session
  open-agent -p "<task>"         run one task, print the result, exit
  echo "<task>" | open-agent -p  same, reading the task from stdin

Options
  -p, --print [task]   non-interactive: run a single task and exit
  -y, --yes            approve "ask"-level tool calls without prompting
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
    help: { type: 'boolean', short: 'h', default: false },
  } as const

  let values: { print: boolean; yes: boolean; help: boolean }
  let positionals: string[]
  try {
    const parsed = parseArgs({ args: argv, options, allowPositionals: true })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)}\n\n${USAGE}` }
  }
  if (values.help) return { ok: true, args: { mode: 'repl', approveAsk: false, help: true } }

  if (!values.print) {
    if (positionals.length > 0) {
      return { ok: false, error: `Unexpected argument "${positionals[0]}". Did you mean -p "${positionals[0]}"?` }
    }
    return { ok: true, args: { mode: 'repl', approveAsk: values.yes, help: false } }
  }

  if (positionals.length > 1) {
    return { ok: false, error: 'Pass the task as a single argument, e.g. -p "run the tests".' }
  }

  return {
    ok: true,
    args: { mode: 'print', prompt: positionals[0], approveAsk: values.yes, help: false },
  }
}
