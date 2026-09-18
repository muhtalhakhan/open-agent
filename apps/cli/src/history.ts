import { readTaskHistory, taskRecords } from '@open-agent/agent'
import type { SessionLog, SessionStore, TaskRecord } from '@open-agent/agent'

/** How much of a prompt or answer one history line shows. */
const PREVIEW_LENGTH = 100

export interface FormatHistoryOptions {
  /** IANA zone to show times in (default: the host's). */
  timeZone?: string
}

/**
 * Renders task records for the terminal: when and how each ended, what was
 * asked, the start of the answer, and the session to resume it from.
 */
export function formatHistory(records: TaskRecord[], options: FormatHistoryOptions = {}): string {
  if (records.length === 0) return 'No past tasks yet.\n'

  const time = new Intl.DateTimeFormat('sv-SE', {
    timeZone: options.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const entries = records.map((record) => {
    const lines = [`${time.format(record.startedAt)}  ${record.status.padEnd(11)}  ${preview(record.prompt)}`]
    if (record.answer) lines.push(`    ${preview(record.answer)}`)
    const where = record.sessionId ?? 'this session'
    const tools = record.toolCalls === 1 ? '1 tool call' : `${record.toolCalls} tool calls`
    lines.push(`    ${where} · ${tools}`)
    return lines.join('\n')
  })
  const resumable = records.some((record) => record.sessionId)
  const footer = resumable ? '\nReopen a session with: open-agent --resume <session id>\n' : ''
  return `${entries.join('\n\n')}\n${footer}`
}

/** One line of text, cut to a preview. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat
}

/**
 * History as the interactive session sees it: saved sessions plus this one,
 * whose tasks are not on disk until it ends. A resumed session is both, so
 * its tasks are taken from memory, which is the more up-to-date copy.
 */
export async function sessionHistory(
  store: Pick<SessionStore, 'list' | 'load'>,
  current: SessionLog,
  { limit = 20, onUnreadable }: { limit?: number; onUnreadable?: (sessionId: string, error: unknown) => void } = {},
): Promise<TaskRecord[]> {
  const live = taskRecords(current.allEvents())
  const liveIds = new Set(live.map((record) => record.taskId))
  const saved = (await readTaskHistory(store, { limit: limit + liveIds.size, onUnreadable })).filter(
    (record) => !liveIds.has(record.taskId),
  )
  return [...live, ...saved].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}

/** One line naming a skipped session, for `onUnreadable`. */
export function describeUnreadable(sessionId: string, error: unknown): string {
  return `Skipped session ${sessionId}: it could not be read (${error instanceof Error ? error.message : String(error)}).\n`
}
