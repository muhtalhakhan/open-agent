import type { AgentLoop, SessionLog, TaskRecord } from '@open-agent/agent'
import type { Job } from '@open-agent/automation'
import type { BackgroundJobs } from './background.js'
import { formatHistory } from './history.js'
import { executeTask, type MemoryHook } from './task.js'

export interface ReplIO {
  /** Resolves to the next line of input, or `null` on EOF (Ctrl+D). */
  prompt(): Promise<string | null>
  write(text: string): void
  /** Optional transient status line (e.g. a TUI's "thinking…" indicator) shown while a task runs. */
  setStatus?(text: string | null): void
}

export interface ReplOptions {
  /** Recalls memories before each task and stores its answer after. */
  memory?: MemoryHook
  /** Enables `:bg`, `:jobs`, `:job` and `:cancel`. */
  background?: BackgroundJobs
  /** Enables `:history`, listing past tasks. */
  history?: () => Promise<TaskRecord[]>
  /** Turns a final answer into what is printed — rendering its Markdown, say. Printed as-is when absent. */
  formatAnswer?: (answer: string) => string
}

/** Lets the caller cancel whichever task is currently running (e.g. from a SIGINT handler). */
export interface AbortRef {
  current: AbortController | null
}

/**
 * The interactive loop: read a line, run one task through the agent loop,
 * print its final answer or status, repeat. `:exit` or EOF ends the
 * session. Pulled out of index.ts so it's testable with fake IO instead of
 * real stdin/stdout.
 *
 * When `memory` is given, each turn recalls relevant past memories and
 * passes them to the agent loop as turn context, then stores the task's
 * final answer as a new memory — a minimal, real use of the MemoryProvider
 * seam, not just mounted-and-unused.
 *
 * When `background` is given, `:bg <task>` sends a task off to run while the
 * session carries on, and `:jobs`, `:job <id>` and `:cancel <id>` manage it.
 * When `history` is given, `:history` lists past tasks.
 */
export async function runRepl(
  agentLoop: AgentLoop,
  sessions: SessionLog,
  io: ReplIO,
  activeAbort: AbortRef,
  { memory, background, history, formatAnswer = (answer) => answer }: ReplOptions = {},
): Promise<void> {
  io.write(
    background
      ? 'OpenAgent CLI — type a task, ":bg <task>" to run one in the background, or ":exit" to quit.\n\n'
      : 'OpenAgent CLI — type a task, or ":exit" to quit.\n\n',
  )
  for (;;) {
    const input = await io.prompt()
    if (input === null) return
    const trimmed = input.trim()
    if (!trimmed) continue
    if (trimmed === ':exit') return
    if (history && trimmed === ':history') {
      // A failure here must not end the session: the current session's work
      // is only saved when runRepl returns normally.
      try {
        io.write(`${formatHistory(await history())}\n`)
      } catch (err) {
        io.write(`Could not read task history: ${err instanceof Error ? err.message : String(err)}\n\n`)
      }
      continue
    }
    if (background && runBackgroundCommand(trimmed, background, io, formatAnswer)) continue

    const controller = new AbortController()
    activeAbort.current = controller
    io.setStatus?.('thinking…')
    const outcome = await executeTask(agentLoop, sessions, trimmed, controller.signal, memory)
    activeAbort.current = null
    io.setStatus?.(null)

    if (outcome.status === 'completed') {
      io.write(`\n${formatAnswer(outcome.answer)}\n\n`)
    } else {
      io.write(`\n[${outcome.status}]${outcome.error ? ` ${outcome.error}` : ''}\n\n`)
    }
  }
}

const BACKGROUND_HELP = `Background jobs:
  :bg <task>     run a task in the background
  :jobs          list background jobs
  :job <id>      show a job's full result or error
  :cancel <id>   cancel a queued or running job
`

/**
 * Handles one of the background-job commands. Returns false for any other
 * line, which then runs as an ordinary task.
 */
function runBackgroundCommand(
  line: string,
  background: BackgroundJobs,
  io: ReplIO,
  formatAnswer: (answer: string) => string,
): boolean {
  const [command, ...rest] = line.split(/\s+/)
  const arg = rest.join(' ')

  switch (command) {
    case ':bg': {
      if (!arg) {
        io.write(BACKGROUND_HELP)
        return true
      }
      const job = background.start(arg)
      io.write(`Started ${job.id} in the background. ":jobs" to check on it.\n\n`)
      return true
    }
    case ':jobs': {
      const jobs = background.list()
      io.write(jobs.length === 0 ? 'No background jobs.\n\n' : `${jobs.map(describeJob).join('\n')}\n\n`)
      return true
    }
    case ':job': {
      const job = arg ? background.find(arg) : undefined
      if (!job) {
        io.write(arg ? `No background job matches "${arg}".\n\n` : 'Usage: :job <id>\n\n')
        return true
      }
      const detail =
        job.status === 'failed' ? `Error: ${job.error}` : job.result ? formatAnswer(job.result) : '(no result yet)'
      io.write(`${describeJob(job)}\nPrompt: ${job.prompt}\n\n${detail}\n\n`)
      return true
    }
    case ':cancel': {
      const job = arg ? background.cancel(arg) : undefined
      io.write(
        job
          ? `Cancelling ${job.id}.\n\n`
          : arg
            ? `No queued or running job matches "${arg}".\n\n`
            : 'Usage: :cancel <id>\n\n',
      )
      return true
    }
    default:
      return false
  }
}

function describeJob(job: Job): string {
  return `${job.id}  ${job.status.padEnd(9)}  ${job.name}`
}
