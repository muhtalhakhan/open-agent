import { randomUUID } from 'node:crypto'
import type { AgentLoop, RunOptions, SessionEvent, SessionLog } from '@open-agent/agent'
import type { MemoryProvider } from '@open-agent/memory'

export interface MemoryHook {
  provider: MemoryProvider
  containerTag: string
}

export interface TaskOutcome {
  status: 'completed' | 'cancelled' | 'error'
  /** The model's final answer. Empty unless the task completed. */
  answer: string
  error?: string
}

export interface TaskOptions {
  memory?: MemoryHook
  /** The model's text as it is generated — see `RunOptions.onText`. */
  onText?: RunOptions['onText']
  /**
   * Every event this task appends to the session log, as it is appended.
   * Only this task's: a background job writing to the same log at the same
   * time is not part of what the person is watching.
   */
  onEvent?: (event: SessionEvent) => void
}

/**
 * Runs one task end to end: recall relevant memories, hand them to the agent
 * loop as turn context, and store the answer once it lands.
 *
 * Shared by the interactive REPL and print mode so the two are the same code
 * path with different IO around them, rather than two implementations of
 * "run a task" that can drift apart.
 */
export async function executeTask(
  agentLoop: AgentLoop,
  sessions: SessionLog,
  input: string,
  signal: AbortSignal,
  { memory, onText, onEvent }: TaskOptions = {},
): Promise<TaskOutcome> {
  // Recalled memories travel as turn context, not as part of the user's
  // message: the log should record what the user actually typed, and
  // background context shouldn't read to the model as the request.
  let context: string | undefined
  if (memory) {
    const recalled = await memory.provider.recall({ q: input, containerTag: memory.containerTag, limit: 5 })
    if (recalled.length > 0) {
      context = `Relevant memory from past sessions:\n${recalled.map((r) => `- ${r.content}`).join('\n')}`
    }
  }

  // The id is chosen here rather than by the loop so the subscription can be
  // filtered to it before the task's first event is appended.
  const taskId = randomUUID()
  const unsubscribe = onEvent && sessions.onAppend((event) => event.taskId === taskId && onEvent(event))
  let task
  try {
    task = await agentLoop.run(input, signal, taskId, { context, onText })
  } finally {
    unsubscribe?.()
  }

  if (task.status !== 'completed') {
    return { status: task.status === 'cancelled' ? 'cancelled' : 'error', answer: '', error: task.error }
  }

  const answer = sessions.deriveMessages(task.id).at(-1)?.content ?? ''
  if (memory && answer) await memory.provider.remember({ content: answer, containerTag: memory.containerTag })
  return { status: 'completed', answer }
}
