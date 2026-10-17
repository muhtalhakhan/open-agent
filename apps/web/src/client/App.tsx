import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import { cancelTask, sendTask, subscribe, type ConnectionState } from './api.js'
import { reduce, type Entry, type Turn, type TurnItem } from './transcript.js'

function formatDuration(ms: number): string {
  const safe = Math.max(0, ms)
  return safe < 1000 ? `${Math.round(safe)}ms` : `${(safe / 1000).toFixed(1)}s`
}

function ToolRow({ item }: { item: Extract<TurnItem, { kind: 'tool' }> }) {
  const mark = item.status === 'running' ? '…' : item.status === 'ok' ? '✓' : '✗'
  return (
    <div className={`tool tool--${item.status}`}>
      <span className="tool__mark" aria-hidden="true">
        {mark}
      </span>
      <code className="tool__call">
        {item.name}
        {item.args && <span className="tool__args"> {item.args}</span>}
      </code>
      {item.ms !== undefined && <span className="tool__ms">{formatDuration(item.ms)}</span>}
      {item.error && <div className="tool__error">{item.error}</div>}
    </div>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <section className="turn" aria-busy={turn.status === 'running'}>
      <div className="turn__input">{turn.input}</div>
      <div className="turn__reply">
        {turn.items.map((item, index) =>
          item.kind === 'text' ? (
            <div key={index} className={item.done ? 'text' : 'text text--live'}>
              {item.text}
            </div>
          ) : item.kind === 'tool' ? (
            <ToolRow key={item.callId} item={item} />
          ) : (
            <div key={index} className="notice notice--inline">
              {item.text}
            </div>
          ),
        )}
        {turn.status === 'running' && turn.items.length === 0 && <div className="thinking">Thinking…</div>}
        {turn.status === 'cancelled' && <div className="outcome">Stopped.</div>}
        {turn.status === 'error' && (
          <div className="outcome outcome--error">Task failed: {turn.error ?? 'unknown error'}</div>
        )}
      </div>
    </section>
  )
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  rejected: 'Not authorised',
}

export function App({ token }: { token: string | null }) {
  const [entries, dispatch] = useReducer(reduce, [] as Entry[])
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => (token ? subscribe(token, dispatch, setConnection) : undefined), [token])

  // Follow the conversation while the reader is at the bottom; leave them
  // alone once they have scrolled up to read something.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [entries])
  const onScroll = () => {
    const el = scroller.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const running = entries.findLast((entry): entry is Turn => entry.kind === 'turn' && entry.status === 'running')

  const submit = useCallback(async () => {
    const input = draft.trim()
    if (!token || !input || running || sending) return
    setSending(true)
    setError(null)
    const failure = await sendTask(token, input)
    setSending(false)
    if (failure) setError(failure)
    else {
      setDraft('')
      pinned.current = true
    }
  }, [draft, token, running, sending])

  const stop = async () => {
    if (!token || !running) return
    const failure = await cancelTask(token, running.taskId)
    if (failure) setError(failure)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  if (!token) {
    return (
      <main className="empty">
        <h1>OpenAgent</h1>
        <p>
          Open the address <code>open-agent web</code> printed in your terminal. It carries the key this page needs.
        </p>
      </main>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <h1>OpenAgent</h1>
        <span className={`connection connection--${connection}`}>{CONNECTION_LABEL[connection]}</span>
      </header>

      <div className="transcript" ref={scroller} onScroll={onScroll} aria-live="polite">
        {connection === 'rejected' && (
          <div className="banner">
            This page's key was refused — the server has probably restarted. Open the new address from the terminal.
          </div>
        )}
        {entries.length === 0 && connection === 'open' && (
          <div className="placeholder">Give the agent a task to start.</div>
        )}
        {entries.map((entry, index) =>
          entry.kind === 'turn' ? (
            <TurnView key={entry.taskId} turn={entry} />
          ) : (
            <div key={index} className="notice">
              {entry.text}
            </div>
          ),
        )}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {error && <div className="composer__error">{error}</div>}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            running ? 'Waiting for the current task…' : 'Describe a task. Enter sends, Shift+Enter adds a line.'
          }
          rows={3}
          disabled={connection !== 'open'}
          aria-label="Task"
        />
        {running ? (
          <button type="button" className="button button--stop" onClick={() => void stop()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="button" disabled={!draft.trim() || sending || connection !== 'open'}>
            Send
          </button>
        )}
      </form>
    </div>
  )
}
