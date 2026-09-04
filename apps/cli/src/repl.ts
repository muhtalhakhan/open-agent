import type { AgentLoop, SessionLog } from '@open-agent/agent'
import type { MemoryProvider } from '@open-agent/memory'

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

export interface MemoryHook {
  provider: MemoryProvider
  containerTag: string
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

    // Recalled memories travel as turn context, not as part of the user's
    // message: the log should record what the user actually typed, and
    // background context shouldn't read to the model as the request.
    let context: string | undefined
    if (memory) {
      const recalled = await memory.provider.recall({ q: trimmed, containerTag: memory.containerTag, limit: 5 })
      if (recalled.length > 0) {
        context = `Relevant memory from past sessions:\n${recalled.map((r) => `- ${r.content}`).join('\n')}`
      }
    }

    const controller = new AbortController()
    activeAbort.current = controller
    io.setStatus?.('thinking…')
    const task = await agentLoop.run(trimmed, controller.signal, undefined, { context })
    activeAbort.current = null
    io.setStatus?.(null)

    if (task.status === 'completed') {
      const messages = sessions.deriveMessages(task.id)
      const answer = messages.at(-1)?.content ?? ''
      io.write(`\n${answer}\n\n`)
      if (memory && answer) await memory.provider.remember({ content: answer, containerTag: memory.containerTag })
    } else {
      io.write(`\n[${task.status}]${task.error ? ` ${task.error}` : ''}\n\n`)
    }
  }
}
