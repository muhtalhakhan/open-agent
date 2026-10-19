import { useEffect, useState } from 'react'
import type { HistoryTask, HistoryTranscript } from '../protocol.js'
import { fetchHistory, fetchTranscript } from './api.js'
import { reduce } from './transcript.js'
import { Entries, formatUsage } from './turn.js'

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Where a task's transcript lives in the page's hash: the saved session, or `live` for this one. */
export function transcriptHref(task: Pick<HistoryTask, 'taskId' | 'sessionId'>): string {
  return `#/history/${task.sessionId ?? 'live'}/${encodeURIComponent(task.taskId)}`
}

type Load<T> = { state: 'loading' } | { state: 'failed'; error: string } | { state: 'ready'; value: T }

function useLoad<T>(load: () => Promise<T | string>, deps: unknown[]): [Load<T>, () => void] {
  const [result, setResult] = useState<Load<T>>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setResult({ state: 'loading' })
    load().then((value) => {
      if (!current) return
      setResult(typeof value === 'string' ? { state: 'failed', error: value } : { state: 'ready', value })
    })
    return () => {
      current = false
    }
    // `load` is rebuilt each render; `deps` say when it actually changes.
  }, [...deps, attempt])
  return [result, () => setAttempt((n) => n + 1)]
}

const STATUS_LABEL: Record<HistoryTask['status'], string> = {
  completed: 'Completed',
  cancelled: 'Stopped',
  error: 'Failed',
  interrupted: 'Interrupted',
}

function TaskRow({ task }: { task: HistoryTask }) {
  const details = [
    task.sessionId ?? 'this session',
    task.toolCalls === 1 ? '1 tool call' : `${task.toolCalls} tool calls`,
    task.usage && formatUsage(task.usage),
  ].filter(Boolean)
  return (
    <li>
      <a className="history-row" href={transcriptHref(task)}>
        <span className="history-row__top">
          <span className={`status status--${task.status}`}>{STATUS_LABEL[task.status]}</span>
          <time dateTime={new Date(task.startedAt).toISOString()}>{when.format(task.startedAt)}</time>
        </span>
        <span className="history-row__prompt">{task.prompt}</span>
        {task.answer && <span className="history-row__answer">{task.answer}</span>}
        <span className="history-row__meta">{details.join(' · ')}</span>
      </a>
    </li>
  )
}

export function HistoryList({ token }: { token: string }) {
  const [tasks, reload] = useLoad(() => fetchHistory(token), [token])
  return (
    <div className="page">
      <div className="page__head">
        <h2>Past tasks</h2>
        <button type="button" className="link-button" onClick={reload}>
          Refresh
        </button>
      </div>
      {tasks.state === 'loading' && <p className="muted">Loading…</p>}
      {tasks.state === 'failed' && <p className="error-text">{tasks.error}</p>}
      {tasks.state === 'ready' && tasks.value.length === 0 && (
        <p className="muted">No tasks yet. Finished tasks from this and earlier sessions show up here.</p>
      )}
      {tasks.state === 'ready' && tasks.value.length > 0 && (
        <ul className="history-list">
          {tasks.value.map((task) => (
            <TaskRow key={`${task.sessionId ?? 'live'}:${task.taskId}`} task={task} />
          ))}
        </ul>
      )}
    </div>
  )
}

export function TaskTranscript({ token, taskId, sessionId }: { token: string; taskId: string; sessionId?: string }) {
  const [transcript] = useLoad<HistoryTranscript>(
    () => fetchTranscript(token, taskId, sessionId),
    [token, taskId, sessionId],
  )
  return (
    <div className="page">
      <div className="page__head">
        <a className="link-button" href="#/history">
          ← Past tasks
        </a>
      </div>
      {transcript.state === 'loading' && <p className="muted">Loading…</p>}
      {transcript.state === 'failed' && <p className="error-text">{transcript.error}</p>}
      {transcript.state === 'ready' && (
        <>
          <p className="muted">
            {STATUS_LABEL[transcript.value.task.status]} · {when.format(transcript.value.task.startedAt)}
            {sessionId && (
              <>
                {' · continue it with '}
                <code>open-agent --resume {sessionId}</code>
              </>
            )}
          </p>
          <Entries entries={transcript.value.events.reduce(reduce, [])} />
        </>
      )}
    </div>
  )
}
