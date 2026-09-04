import type { AgentLoop, SessionLog } from '@open-agent/agent'
import { executeTask, type MemoryHook } from './task.js'

/** Conventional shell exit codes: 130 is "terminated by SIGINT". */
export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_CANCELLED = 130

export interface HeadlessIO {
  /** The answer, and nothing else — this is what a script captures. */
  out(text: string): void
  /** Progress, warnings, failures. Never part of the captured result. */
  err(text: string): void
}

export interface HeadlessOptions {
  prompt: string
  io: HeadlessIO
  signal: AbortSignal
  memory?: MemoryHook
}

/**
 * Runs a single task and reports an exit code, for CI jobs and shell scripts.
 *
 * Deliberately splits the streams: only the final answer reaches stdout, so
 * `open-agent -p "..." > answer.txt` captures the answer alone and nothing
 * has to be parsed back out of decorated terminal output.
 */
export async function runHeadless(
  agentLoop: AgentLoop,
  sessions: SessionLog,
  { prompt, io, signal, memory }: HeadlessOptions,
): Promise<number> {
  const trimmed = prompt.trim()
  if (!trimmed) {
    io.err('No task given. Pass one as `-p "<task>"` or on stdin.\n')
    return EXIT_ERROR
  }

  const outcome = await executeTask(agentLoop, sessions, trimmed, signal, memory)

  if (outcome.status === 'completed') {
    // Exactly one trailing newline, so the output composes with other tools.
    io.out(outcome.answer.endsWith('\n') ? outcome.answer : `${outcome.answer}\n`)
    return EXIT_OK
  }

  if (outcome.status === 'cancelled') {
    io.err('Cancelled.\n')
    return EXIT_CANCELLED
  }

  io.err(`Task failed: ${outcome.error ?? 'unknown error'}\n`)
  return EXIT_ERROR
}
