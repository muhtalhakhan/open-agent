import type { Message, SessionEvent } from './types.js'
import type { StoredSession } from './session-store.js'

/** How much of the last assistant message a task summary carries. */
const SUMMARY_LENGTH = 120

/** A one-line description of a past task, for history/recall. */
export interface TaskSummary {
  taskId: string
  /** The task's `turn/end` reason, or `'unknown'` if it never ended. */
  status: 'completed' | 'cancelled' | 'error' | 'unknown'
  summary: string
}

/**
 * The session log is the source of truth for what a task has seen and done.
 * Nothing reaches the model unless it was appended here first — anything
 * else (a raw provider response, a side channel) is not "model-visible"
 * and must not silently influence the next request.
 */
export class SessionLog {
  private readonly events: SessionEvent[] = []
  private readonly listeners = new Set<(event: SessionEvent) => void>()

  append(event: SessionEvent): SessionEvent {
    this.events.push(event)
    for (const listener of this.listeners) {
      // A listener is a view of the log, never part of it. One that throws
      // must not stop the event being recorded — it already is — or reach
      // the agent loop that appended it and fail the task over a display bug.
      try {
        listener(event)
      } catch {
        // Deliberately dropped: the log has no channel to report it on.
      }
    }
    return event
  }

  /**
   * Calls `listener` with every event appended from now on, so a live view
   * (the CLI's tool activity, a web UI's step stream) is a projection of the
   * log rather than a second source of truth fed from somewhere else. Events
   * restored by `loadFrom` are history, not activity, and are not replayed.
   * Returns the unsubscribe function.
   */
  onAppend(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  all(taskId: string): SessionEvent[] {
    return this.events.filter((e) => e.taskId === taskId)
  }

  /** All events, regardless of task. */
  allEvents(): SessionEvent[] {
    return this.events
  }

  /** Every task id in the durable log, oldest task first. */
  findTasks(): string[] {
    const firstSeen = new Map<string, number>()
    for (const e of this.events) if (!firstSeen.has(e.taskId)) firstSeen.set(e.taskId, e.at)
    return Array.from(firstSeen)
      .sort(([, a], [, b]) => a - b)
      .map(([id]) => id)
  }

  /** Summarize a completed task from its last assistant message or turn/end. */
  getTaskSummary(taskId: string): TaskSummary | undefined {
    const ev = this.all(taskId)
    if (!ev.length) return undefined
    const end = ev.filter((e) => e.type === 'turn/end').pop()
    const lastMsg = ev.filter((e) => e.type === 'assistant/message').pop()
    return {
      taskId,
      status: end ? end.reason : 'unknown',
      summary: lastMsg ? lastMsg.message.content.slice(0, SUMMARY_LENGTH) : 'No message',
    }
  }

  /** Project the model-visible message history out of the durable log. */
  deriveMessages(taskId: string): Message[] {
    const messages: Message[] = []
    for (const event of this.all(taskId)) {
      if (event.type === 'system/message' || event.type === 'user/message' || event.type === 'assistant/message') {
        messages.push(event.message)
      } else if (event.type === 'tool/result') {
        messages.push({
          role: 'tool',
          content: event.result.ok ? event.result.content : `Error: ${event.result.error}`,
          toolCallId: event.callId,
        })
      }
    }
    return messages
  }

  /** Load events from an external source (e.g. session resume). */
  loadFrom(stored: StoredSession): void {
    for (const event of stored.events) {
      this.events.push(event)
    }
  }
}
