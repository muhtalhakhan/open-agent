import { useState } from 'react'
import type { ApprovalScope, Usage } from '../protocol.js'
import type { ApprovalItem, Entry, Turn, TurnItem } from './transcript.js'

/** Sends a person's answer; resolves to an error message, or `null` once taken. */
export type AnswerApproval = (
  approvalId: string,
  answer: { approved: true; scope: ApprovalScope } | { approved: false },
) => Promise<string | null>

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
  const row = (
    <>
      <span className="tool__mark" aria-hidden="true">
        {mark}
      </span>
      <code className="tool__call">
        {item.name}
        {item.args && <span className="tool__args"> {item.args}</span>}
      </code>
      {item.ms !== undefined && <span className="tool__ms">{formatDuration(item.ms)}</span>}
      {item.error && <div className="tool__error">{item.error}</div>}
    </>
  )
  // What a call returned is there to look at, not to read by default: most
  // of it was for the model, and a page of file contents per call would bury
  // the conversation.
  if (item.output) {
    return (
      <details className={`tool tool--${item.status} tool--expandable`}>
        <summary className="tool__summary">{row}</summary>
        <pre className="tool__output">{item.output}</pre>
      </details>
    )
  }
  return <div className={`tool tool--${item.status}`}>{row}</div>
}

/**
 * What a running turn is doing right now, in one line: which tool, or that
 * it is waiting on the model. Nothing while text is streaming or a question
 * is waiting, since those already show themselves.
 */
function activity(turn: Turn): string | null {
  if (turn.status !== 'running') return null
  const last = turn.items.at(-1)
  if (last?.kind === 'approval' && last.state === 'pending') return null
  if (last?.kind === 'text' && !last.done) return null
  if (last?.kind === 'tool' && last.status === 'running') return `Step ${turn.step ?? 1} · running ${last.name}…`
  return `Step ${turn.step ?? 1} · waiting for the model…`
}

const SCOPE_BUTTON: Record<ApprovalScope, string> = {
  once: 'Approve once',
  task: 'Approve for this task',
  session: 'Always, this session…',
}

const SCOPE_DONE: Record<ApprovalScope, string> = {
  once: 'Approved once',
  task: 'Approved for the rest of this task',
  session: 'Approved for the rest of this session',
}

/** A unified diff with additions and removals marked, as the terminal colours them. */
function Diff({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split('\n').map((line, index) => {
        const kind =
          line.startsWith('+') && !line.startsWith('+++')
            ? 'add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'remove'
              : line.startsWith('@@')
                ? 'hunk'
                : 'context'
        return (
          <span key={index} className={`diff__line diff__line--${kind}`}>
            {line}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}

/**
 * The browser's version of the terminal's approval prompt: the call, why it
 * is being asked about, and only the answers the registry will honour for it.
 * "Always" takes a second click, as it takes a second `y` in the terminal —
 * it removes every future prompt for this call, so it should not be one
 * stray click away.
 */
function ApprovalCard({ item, answer }: { item: ApprovalItem; answer?: AnswerApproval }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (decision: Parameters<AnswerApproval>[1]) => {
    if (!answer) return
    setBusy(true)
    setError(null)
    const failure = await answer(item.approvalId, decision)
    setBusy(false)
    if (failure) setError(failure)
  }

  const subject = item.escalation ? (
    <p className="approval__reason">
      <strong>Held for review.</strong> {item.escalation.reason}
    </p>
  ) : null
  const title = item.planPreview ? (
    <>
      Approve this change by <code>{item.tool}</code>?
    </>
  ) : (
    <>
      Approve <code>{item.tool}</code> <span className={`level level--${item.level}`}>{item.level}</span>?
    </>
  )

  return (
    <div className={`approval approval--${item.state}`} role="group" aria-label={`Approval for ${item.tool}`}>
      {subject}
      <p className="approval__title">{title}</p>
      {item.planPreview !== undefined ? (
        <Diff text={item.planPreview} />
      ) : (
        <pre className="approval__args">{item.args}</pre>
      )}
      {item.state === 'pending' && answer && !confirming && (
        <div className="approval__actions">
          {item.scopes.map((scope) => (
            <button
              key={scope}
              type="button"
              className={scope === 'once' ? 'button' : 'button button--secondary'}
              disabled={busy}
              onClick={() => (scope === 'session' ? setConfirming(true) : void send({ approved: true, scope }))}
            >
              {SCOPE_BUTTON[scope]}
            </button>
          ))}
          <button
            type="button"
            className="button button--stop"
            disabled={busy}
            onClick={() => void send({ approved: false })}
          >
            Deny
          </button>
        </div>
      )}
      {item.state === 'pending' && confirming && (
        <div className="approval__actions">
          <span className="approval__confirm">
            Approve <code>{item.tool}</code> with exactly these arguments for the rest of this session, without asking?
          </span>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => void send({ approved: true, scope: 'session' })}
          >
            Yes, always
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Back
          </button>
        </div>
      )}
      {item.state !== 'pending' && (
        <p className={`approval__outcome approval__outcome--${item.state}`}>
          {item.state === 'approved' ? SCOPE_DONE[item.scope ?? 'once'] : 'Denied'}
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

function TurnView({ turn, answer }: { turn: Turn; answer?: AnswerApproval }) {
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
          ) : item.kind === 'approval' ? (
            <ApprovalCard key={item.approvalId} item={item} answer={answer} />
          ) : item.kind === 'screen' ? (
            <figure key="screen" className="screen">
              <img src={`data:${item.mimeType};base64,${item.data}`} alt={item.caption ?? 'What the tool showed'} />
              {item.caption && <figcaption>Browser · {item.caption}</figcaption>}
            </figure>
          ) : item.kind === 'step' ? (
            <div key={index} className="step-divider">
              Step {item.step}
            </div>
          ) : item.kind === 'retry' ? (
            <div key={index} className="retry">
              Retrying (attempt {item.attempt + 1}): {item.reason}
            </div>
          ) : (
            <div key={index} className="notice notice--inline">
              {item.text}
            </div>
          ),
        )}
        {activity(turn) && <div className="thinking">{activity(turn)}</div>}
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
export function Entries({ entries, answer }: { entries: Entry[]; answer?: AnswerApproval }) {
  return entries.map((entry, index) =>
    entry.kind === 'turn' ? (
      <TurnView key={`${entry.taskId}:${index}`} turn={entry} answer={answer} />
    ) : (
      <div key={index} className="notice">
        {entry.text}
      </div>
    ),
  )
}
