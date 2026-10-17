import type { HistoryTask, HistoryTranscript, ServerEvent } from '../protocol.js'

const TOKEN_KEY = 'open-agent:token'

/**
 * The token arrives in the URL the terminal printed. It is moved into session
 * storage and out of the address bar straight away, so it does not end up in
 * browser history, a screenshot, or a link copied from the page. Session
 * storage dies with the tab: a new tab needs the printed URL again, which is
 * the point.
 */
export function takeToken(): string | null {
  const url = new URL(window.location.href)
  const fromUrl = url.searchParams.get('token')
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl)
    } catch {
      // Storage blocked: the token lives only as long as this page then.
    }
    url.searchParams.delete('token')
    window.history.replaceState(null, '', url)
    return fromUrl
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

async function post(token: string, path: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    if (res.ok) return null
    const payload = (await res.json().catch(() => ({}))) as { error?: string }
    return payload.error ?? `Request failed (${res.status}).`
  } catch {
    return 'Could not reach the agent. Is `open-agent web` still running?'
  }
}

/** Resolves to an error message, or `null` once the task has been accepted. */
export function sendTask(token: string, input: string): Promise<string | null> {
  return post(token, '/api/tasks', { input })
}

export function cancelTask(token: string, taskId: string): Promise<string | null> {
  return post(token, `/api/tasks/${encodeURIComponent(taskId)}/cancel`, {})
}

export type ConnectionState = 'connecting' | 'open' | 'rejected'

/**
 * Follows the server's event stream. EventSource reconnects by itself after a
 * dropped connection; each reconnect starts with `hello` and a full replay.
 * A refused token is different — retrying cannot fix it — so that closes it.
 */
export function subscribe(
  token: string,
  onEvent: (event: ServerEvent) => void,
  onState: (state: ConnectionState) => void,
): () => void {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`)
  source.onopen = () => onState('open')
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as ServerEvent)
  source.onerror = () => {
    // The browser gives up on its own after a non-200 answer, which here
    // means the token; any other failure leaves it reconnecting.
    if (source.readyState === EventSource.CLOSED) onState('rejected')
    else onState('connecting')
  }
  return () => source.close()
}

async function get<T>(token: string, path: string): Promise<T | string> {
  try {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } })
    const payload = (await res.json().catch(() => ({}))) as T & { error?: string }
    return res.ok ? payload : (payload.error ?? `Request failed (${res.status}).`)
  } catch {
    return 'Could not reach the agent. Is `open-agent web` still running?'
  }
}

/** Resolves to the tasks, or to an error message. */
export async function fetchHistory(token: string): Promise<HistoryTask[] | string> {
  const result = await get<{ tasks: HistoryTask[] }>(token, '/api/history')
  return typeof result === 'string' ? result : result.tasks
}

export function fetchTranscript(
  token: string,
  taskId: string,
  sessionId?: string,
): Promise<HistoryTranscript | string> {
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
  return get<HistoryTranscript>(token, `/api/history/${encodeURIComponent(taskId)}${query}`)
}
