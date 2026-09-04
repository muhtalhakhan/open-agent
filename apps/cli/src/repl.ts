import type { AgentLoop, SessionLog } from '@open-agent/agent'
import { executeTask, type MemoryHook } from './task.js'

export interface ReplIO {
  /** Resolves to the next line of input, or `null` on EOF (Ctrl+D). */
  prompt(): Promise<string | null>
  write(text: string): void
  /** Optional transient status line (e.g. a TUI's "thinking…" indicator) shown while a task runs. */
  setStatus?(text: string | null): void
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
 */
export async function runRepl(
  agentLoop: AgentLoop,
  sessions: SessionLog,
  io: ReplIO,
  activeAbort: AbortRef,
  memory?: MemoryHook,
): Promise<void> {
  io.write('OpenAgent CLI — type a task, or ":exit" to quit.\n\n')
  for (;;) {
    const input = await io.prompt()
    if (input === null) return
    const trimmed = input.trim()
    if (!trimmed) continue
    if (trimmed === ':exit') return

    const controller = new AbortController()
    activeAbort.current = controller
    io.setStatus?.('thinking…')
    const outcome = await executeTask(agentLoop, sessions, trimmed, controller.signal, memory)
    activeAbort.current = null
    io.setStatus?.(null)

    if (outcome.status === 'completed') {
      io.write(`\n${outcome.answer}\n\n`)
    } else {
      io.write(`\n[${outcome.status}]${outcome.error ? ` ${outcome.error}` : ''}\n\n`)
    }
  }
}
