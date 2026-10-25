import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import { answerApproval, cancelTask, sendTask, subscribe, type ConnectionState } from './api.js'
import { HistoryList, TaskTranscript } from './history.js'
import { MemoryView } from './memory.js'
import { ProfilesPage } from './profiles.js'
import { SettingsPage } from './settings.js'
import { reduce, type Entry, type Turn } from './transcript.js'
import { Entries, type AnswerApproval } from './turn.js'

type Route =
  | { view: 'chat' }
  | { view: 'history' }
  | { view: 'transcript'; taskId: string; sessionId?: string }
  | { view: 'memory' }
  | { view: 'profiles' }
  | { view: 'settings' }

/** `#/history`, `#/history/<session or live>/<task>`, `#/memory`, `#/profiles` and `#/settings`; anything else is the chat. */
function parseRoute(hash: string): Route {
  const [page, session, task] = hash.replace(/^#\/?/, '').split('/')
  if (page === 'memory') return { view: 'memory' }
  if (page === 'profiles') return { view: 'profiles' }
  if (page === 'settings') return { view: 'settings' }
  if (page !== 'history') return { view: 'chat' }
  if (session && task) {
    return { view: 'transcript', taskId: decodeURIComponent(task), sessionId: session === 'live' ? undefined : session }
  }
  return { view: 'history' }
}

/**
 * The hash rather than the path: the server serves one page, and a hash
 * change never reaches it, so a reload or a shared link lands on the same view
 * without the server having to know the client's routes.
 */
function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  rejected: 'Not authorised',
}

function Chat({
  token,
  hidden,
  onConnection,
}: {
  token: string
  hidden: boolean
  onConnection: (state: ConnectionState) => void
}) {
  const [entries, dispatch] = useReducer(reduce, [] as Entry[])
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(
    () =>
      subscribe(token, dispatch, (state) => {
        setConnection(state)
        onConnection(state)
      }),
    [token, onConnection],
  )

  // Follow the conversation while the reader is at the bottom; leave them
  // alone once they have scrolled up to read something.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [entries, hidden])
  const onScroll = () => {
    const el = scroller.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const running = entries.findLast((entry): entry is Turn => entry.kind === 'turn' && entry.status === 'running')
  const waiting = running?.items.some((item) => item.kind === 'approval' && item.state === 'pending') ?? false

  // A question in a background tab is easy to miss, and the agent is parked
  // until someone answers it.
  useEffect(() => {
    document.title = waiting ? 'Approval needed · OpenAgent' : 'OpenAgent'
  }, [waiting])

  const answer = useCallback<AnswerApproval>(
    (approvalId, decision) => answerApproval(token, approvalId, decision),
    [token],
  )

  const submit = useCallback(async () => {
    const input = draft.trim()
    if (!input || running || sending) return
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
    if (!running) return
    const failure = await cancelTask(token, running.taskId)
    if (failure) setError(failure)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  // Kept mounted while another view is open, so the stream, the draft and the
  // scroll position are where they were on the way back.
  return (
    <div className="chat" hidden={hidden}>
      <div className="transcript" ref={scroller} onScroll={onScroll} aria-live="polite">
        {connection === 'rejected' && (
          <div className="banner">
            This page's key was refused — the server has probably restarted. Open the new address from the terminal.
          </div>
        )}
        {entries.length === 0 && connection === 'open' && (
          <div className="placeholder">Give the agent a task to start.</div>
        )}
        <Entries entries={entries} answer={answer} />
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
            waiting
              ? 'The agent is waiting for your answer above.'
              : running
                ? 'Waiting for the current task…'
                : 'Describe a task. Enter sends, Shift+Enter adds a line.'
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

export function App({ token }: { token: string | null }) {
  const route = useRoute()
  const [connection, setConnection] = useState<ConnectionState>('connecting')

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
        <nav className="nav" aria-label="Views">
          <a href="#/" aria-current={route.view === 'chat' ? 'page' : undefined}>
            Chat
          </a>
          <a
            href="#/history"
            aria-current={route.view === 'history' || route.view === 'transcript' ? 'page' : undefined}
          >
            History
          </a>
          <a href="#/memory" aria-current={route.view === 'memory' ? 'page' : undefined}>
            Memory
          </a>
          <a href="#/profiles" aria-current={route.view === 'profiles' ? 'page' : undefined}>
            Profiles
          </a>
          <a href="#/settings" aria-current={route.view === 'settings' ? 'page' : undefined}>
            Settings
          </a>
        </nav>
        <span className={`connection connection--${connection}`}>{CONNECTION_LABEL[connection]}</span>
      </header>

      <Chat token={token} hidden={route.view !== 'chat'} onConnection={setConnection} />
      {route.view === 'history' && <HistoryList token={token} />}
      {route.view === 'memory' && <MemoryView token={token} />}
      {route.view === 'profiles' && <ProfilesPage token={token} />}
      {route.view === 'settings' && <SettingsPage token={token} />}
      {route.view === 'transcript' && (
        <TaskTranscript token={token} taskId={route.taskId} sessionId={route.sessionId} />
      )}
    </div>
  )
}
