import { useEffect, useState, type FormEvent } from 'react'
import type { MemoryListing, MemoryRecord } from '../protocol.js'
import { fetchMemory, forgetMemory, updateMemory } from './api.js'

/**
 * One memory, with the two things a person can do about it. Forgetting takes
 * a second click: it is the one action on this page that cannot be undone,
 * and the agent stops drawing on the memory from its next task.
 */
function MemoryRow({
  token,
  item,
  onForgotten,
  onEdited,
}: {
  token: string
  item: MemoryRecord
  onForgotten: () => void
  onEdited: (content: string) => void
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view')
  const [draft, setDraft] = useState(item.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<string | null>, done: () => void) => {
    setBusy(true)
    setError(null)
    const failure = await action()
    setBusy(false)
    if (failure) setError(failure)
    else done()
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    const content = draft.trim()
    if (!content || content === item.content) return setMode('view')
    void run(
      () => updateMemory(token, item.id, content),
      () => {
        onEdited(content)
        setMode('view')
      },
    )
  }

  return (
    <li className="memory-row">
      {mode === 'edit' ? (
        <form className="memory-row__edit" onSubmit={save}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} aria-label="Memory" />
          <div className="approval__actions">
            <button type="submit" className="button" disabled={busy || !draft.trim()}>
              Save
            </button>
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => {
                setDraft(item.content)
                setMode('view')
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="memory-row__content">{item.content}</p>
      )}
      <div className="memory-row__meta">
        <code>{item.id}</code>
        {item.score !== undefined && <span>match {Math.round(item.score * 100)}%</span>}
        {mode === 'view' && (
          <span className="memory-row__actions">
            <button type="button" className="link-button" onClick={() => setMode('edit')}>
              Edit
            </button>
            <button type="button" className="link-button link-button--danger" onClick={() => setMode('confirm')}>
              Forget
            </button>
          </span>
        )}
      </div>
      {mode === 'confirm' && (
        <div className="approval__actions memory-row__confirm">
          <span>Forget this? The agent will stop recalling it, and it cannot be brought back.</span>
          <button
            type="button"
            className="button button--stop"
            disabled={busy}
            onClick={() => void run(() => forgetMemory(token, item.id), onForgotten)}
          >
            Forget
          </button>
          <button type="button" className="button button--secondary" disabled={busy} onClick={() => setMode('view')}>
            Keep
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </li>
  )
}

export function MemoryView({ token }: { token: string }) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<MemoryListing | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setError(null)
    fetchMemory(token, query).then((result) => {
      if (!current) return
      if (typeof result === 'string') setError(result)
      else setListing(result)
    })
    return () => {
      current = false
    }
  }, [token, query])

  const change = (update: (items: MemoryRecord[]) => MemoryRecord[]) =>
    setListing((previous) => previous && { ...previous, items: update(previous.items) })

  return (
    <div className="page">
      <div className="page__head">
        <h2>Memory</h2>
        {listing && (
          <span className="muted">
            {listing.provider} · <code>{listing.containerTag}</code>
          </span>
        )}
      </div>
      <p className="muted">
        What the agent recalls from past tasks. Relevant memories are added to each new task, so anything wrong or
        private here is worth editing or forgetting.
      </p>
      <form
        className="memory-search"
        onSubmit={(event) => {
          event.preventDefault()
          setQuery(draft.trim())
        }}
      >
        <input
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search memories"
          aria-label="Search memories"
        />
        <button type="submit" className="button button--secondary">
          Search
        </button>
        {query && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setDraft('')
              setQuery('')
            }}
          >
            Clear
          </button>
        )}
      </form>
      {error && <p className="error-text">{error}</p>}
      {!listing && !error && <p className="muted">Loading…</p>}
      {listing && !listing.query && !listing.canList && (
        <p className="muted">
          The {listing.provider} memory provider cannot list everything at once. Search to find what it remembers.
        </p>
      )}
      {listing && (listing.query || listing.canList) && listing.items.length === 0 && (
        <p className="muted">{listing.query ? `Nothing matches "${listing.query}".` : 'Nothing remembered yet.'}</p>
      )}
      {listing && listing.items.length > 0 && (
        <ul className="memory-list">
          {listing.items.map((item) => (
            <MemoryRow
              key={item.id}
              token={token}
              item={item}
              onForgotten={() => change((items) => items.filter((m) => m.id !== item.id))}
              onEdited={(content) => change((items) => items.map((m) => (m.id === item.id ? { ...m, content } : m)))}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
