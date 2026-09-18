import type { SessionEvent } from './types.js'
import type { SessionStore } from './session-store.js'

/** One past task, as the session log recorded it. */
export interface TaskRecord {
  taskId: string
  /** The saved session the task belongs to, when it was read from one. */
  sessionId?: string
  /** What the user asked — the task's first user message. */
  prompt: string
  /**
   * How its last turn ended. `interrupted` means a turn started and never
   * ended: the process died or was killed mid-run, so no outcome was logged.
   */
  status: 'completed' | 'cancelled' | 'error' | 'interrupted'
  startedAt: number
  /** When its last turn ended; absent for an interrupted task. */
  endedAt?: number
  /** The final answer, when the last turn completed. */
  answer?: string
  /** Tool calls the model made across all of the task's turns. */
  toolCalls: number
}

export interface TaskHistoryOptions {
  /** Most tasks to return (default 20). */
  limit?: number
  /** Only tasks that ended this way. */
  status?: TaskRecord['status'] | TaskRecord['status'][]
  /**
   * Told about a saved session that could not be read — truncated JSON, a
   * permissions problem. The session is skipped rather than failing the whole
   * history: one bad file should not hide every other task.
   */
  onUnreadable?: (sessionId: string, error: unknown) => void
}

/**
 * Projects task records out of a session's events, oldest task first.
 *
 * Derived from the log rather than kept alongside it, like everything else
 * about a task: a second store could disagree with the transcript, and the
 * transcript is the thing that actually happened.
 */
export function taskRecords(events: SessionEvent[], sessionId?: string): TaskRecord[] {
  const byTask = new Map<string, SessionEvent[]>()
  for (const event of events) {
    const list = byTask.get(event.taskId)
    if (list) list.push(event)
    else byTask.set(event.taskId, [event])
  }

  const records: TaskRecord[] = []
  for (const [taskId, taskEvents] of byTask) {
    const prompt = taskEvents.find((e) => e.type === 'user/message')
    // A task with no user message is not something anyone asked for — a
    // stray system event, say — and would read as a blank row.
    if (!prompt || prompt.type !== 'user/message') continue

    // Positions in the log, not timestamps: a turn can start in the same
    // millisecond the previous one ended, and only the order tells them apart.
    let lastStart = -1
    let lastEnd: Extract<SessionEvent, { type: 'turn/end' }> | undefined
    let lastEndIndex = -1
    let answer: string | undefined
    let toolCalls = 0
    taskEvents.forEach((e, index) => {
      if (e.type === 'turn/start') lastStart = index
      else if (e.type === 'turn/end') [lastEnd, lastEndIndex] = [e, index]
      else if (e.type === 'assistant/message') answer = e.message.content
      else if (e.type === 'tool/call') toolCalls++
    })
    // A turn that started after the last one ended never finished itself.
    const ended = lastEndIndex > lastStart ? lastEnd : undefined

    records.push({
      taskId,
      ...(sessionId === undefined ? {} : { sessionId }),
      prompt: prompt.message.content,
      status: ended ? ended.reason : 'interrupted',
      startedAt: taskEvents[0].at,
      ...(ended ? { endedAt: ended.at } : {}),
      ...(ended?.reason === 'completed' && answer !== undefined ? { answer } : {}),
      toolCalls,
    })
  }
  return records.sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * The most recent tasks across every saved session, newest first.
 *
 * Every session is read. Stopping early once `limit` tasks were found looks
 * cheaper but is wrong: sessions are ordered by when they were last written,
 * so a resumed month-old session sorts first and its old tasks would fill the
 * limit ahead of yesterday's.
 */
export async function readTaskHistory(
  store: Pick<SessionStore, 'list' | 'load'>,
  options: TaskHistoryOptions = {},
): Promise<TaskRecord[]> {
  const limit = options.limit ?? 20
  const wanted = options.status === undefined ? undefined : new Set([options.status].flat())
  const found: TaskRecord[] = []

  for (const id of await store.list()) {
    let session: Awaited<ReturnType<typeof store.load>>
    try {
      session = await store.load(id)
    } catch (err) {
      options.onUnreadable?.(id, err)
      continue
    }
    if (!session) continue
    found.push(...taskRecords(session.events, id).filter((r) => wanted === undefined || wanted.has(r.status)))
  }
  return found.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}
