import type { Usage } from '../protocol.js'
import type { Entry, Turn, TurnItem } from './transcript.js'

export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms)
  return safe < 1000 ? `${Math.round(safe)}ms` : `${(safe / 1000).toFixed(1)}s`
}

const count = new Intl.NumberFormat('en-US')

/** The same wording as the terminal's `formatUsage`, so the two read alike. */
export function formatUsage(usage: Usage): string {
  const cached = usage.cachedInputTokens ? ` (${count.format(usage.cachedInputTokens)} cached)` : ''
  return `${count.format(usage.inputTokens)} tokens in${cached} · ${count.format(usage.outputTokens)} out`
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
        {turn.usage && <div className="usage">{formatUsage(turn.usage)}</div>}
      </div>
    </section>
  )
}

/**
 * A conversation, live or replayed from history. Keyed by position as well
 * as task: a task resumed and continued has several turns under one id.
 */
export function Entries({ entries }: { entries: Entry[] }) {
  return entries.map((entry, index) =>
    entry.kind === 'turn' ? (
      <TurnView key={`${entry.taskId}:${index}`} turn={entry} />
    ) : (
      <div key={index} className="notice">
        {entry.text}
      </div>
    ),
  )
}
