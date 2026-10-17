/**
 * What the server streams to the browser over `GET /api/events`. Shared by
 * both ends, and deliberately free of imports: the client is compiled for the
 * browser, and pulling in `@open-agent/agent` would pull Node into it.
 */

/** The model's text as it is generated — `RunTextEvent` from the agent, restated. */
export type TextEvent = { type: 'delta'; text: string } | { type: 'reset' } | { type: 'end' }

export type TaskEndStatus = 'completed' | 'cancelled' | 'error'

/** `TokenUsage` from the agent, restated: what a task cost, as the provider reported it. */
export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
}

export type ServerEvent =
  /**
   * Opens every connection. Everything after it up to the live edge is a
   * replay, so a client that reconnects starts again from empty rather than
   * appending a second copy of the conversation.
   */
  | { type: 'hello' }
  /** Something the operator should see that is not part of a task's answer: a tool that loaded, a call denied. */
  | { type: 'notice'; text: string }
  | { type: 'task/start'; taskId: string; input: string }
  | { type: 'text'; taskId: string; event: TextEvent }
  /** `args` is already clipped: a `write_file` call's arguments can be the whole file. */
  | { type: 'tool/start'; taskId: string; callId: string; name: string; args: string }
  | { type: 'tool/end'; taskId: string; callId: string; ok: boolean; error?: string; ms: number }
  | { type: 'task/end'; taskId: string; status: TaskEndStatus; answer: string; error?: string; usage?: Usage }

/** One past task in `GET /api/history`: `TaskRecord` from the agent, restated, with the answer cut to a preview. */
export interface HistoryTask {
  taskId: string
  /** The saved session it belongs to; absent for a task from the session still running. */
  sessionId?: string
  prompt: string
  /** `interrupted` means it started and never ended: the process died mid-task. */
  status: 'completed' | 'cancelled' | 'error' | 'interrupted'
  startedAt: number
  endedAt?: number
  answer?: string
  toolCalls: number
  usage?: Usage
}

/**
 * `GET /api/history/<task>`: the task's transcript as the same events the
 * live stream sends, so the page draws a past task exactly as it drew it live.
 */
export interface HistoryTranscript {
  task: HistoryTask
  events: ServerEvent[]
}
