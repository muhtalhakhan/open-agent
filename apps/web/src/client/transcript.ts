import type { ServerEvent, TaskEndStatus } from '../protocol.js'

export type TurnItem =
  | { kind: 'text'; text: string; done: boolean }
  | {
      kind: 'tool'
      callId: string
      name: string
      args: string
      status: 'running' | 'ok' | 'failed'
      error?: string
      ms?: number
    }
  | { kind: 'notice'; text: string }

export interface Turn {
  kind: 'turn'
  taskId: string
  input: string
  items: TurnItem[]
  status: 'running' | TaskEndStatus
  error?: string
}

export type Entry = Turn | { kind: 'notice'; text: string }

/**
 * The conversation as the page shows it, folded from the server's events.
 * A pure function of them, so a reconnect that replays the stream rebuilds
 * exactly what was on screen.
 */
export type Transcript = Entry[]

/** Copies the turn for `taskId` and hands it to `change`; unknown tasks (trimmed from the replay) are ignored. */
function updateTurn(state: Transcript, taskId: string, change: (turn: Turn) => void): Transcript {
  const index = state.findLastIndex((entry) => entry.kind === 'turn' && entry.taskId === taskId)
  if (index === -1) return state
  const turn = { ...(state[index] as Turn) }
  turn.items = [...turn.items]
  change(turn)
  const next = [...state]
  next[index] = turn
  return next
}

/** The text the model is still writing, if the last thing in the turn is that. */
function openText(turn: Turn): number {
  const last = turn.items.length - 1
  const item = turn.items[last]
  return item?.kind === 'text' && !item.done ? last : -1
}

export function reduce(state: Transcript, event: ServerEvent): Transcript {
  switch (event.type) {
    case 'hello':
      return []
    case 'notice': {
      // Said while a task runs, it is about that task — a call denied, most
      // often — and belongs next to it rather than below the whole turn.
      const last = state.at(-1)
      if (last?.kind === 'turn' && last.status === 'running') {
        return updateTurn(state, last.taskId, (turn) => turn.items.push({ kind: 'notice', text: event.text }))
      }
      return [...state, { kind: 'notice', text: event.text }]
    }
    case 'task/start':
      return [...state, { kind: 'turn', taskId: event.taskId, input: event.input, items: [], status: 'running' }]
    case 'text':
      return updateTurn(state, event.taskId, (turn) => {
        const open = openText(turn)
        if (event.event.type === 'delta') {
          if (open === -1) turn.items.push({ kind: 'text', text: event.event.text, done: false })
          else {
            const item = turn.items[open] as Extract<TurnItem, { kind: 'text' }>
            turn.items[open] = { ...item, text: item.text + event.event.text }
          }
        } else if (open !== -1) {
          // A reset takes back a reply that is being retried; an end freezes one that is complete.
          if (event.event.type === 'reset') turn.items.splice(open, 1)
          else turn.items[open] = { ...(turn.items[open] as Extract<TurnItem, { kind: 'text' }>), done: true }
        }
      })
    case 'tool/start':
      return updateTurn(state, event.taskId, (turn) => {
        turn.items.push({ kind: 'tool', callId: event.callId, name: event.name, args: event.args, status: 'running' })
      })
    case 'tool/end':
      return updateTurn(state, event.taskId, (turn) => {
        const index = turn.items.findIndex((item) => item.kind === 'tool' && item.callId === event.callId)
        if (index === -1) return
        const item = turn.items[index] as Extract<TurnItem, { kind: 'tool' }>
        turn.items[index] = { ...item, status: event.ok ? 'ok' : 'failed', error: event.error, ms: event.ms }
      })
    case 'task/end':
      return updateTurn(state, event.taskId, (turn) => {
        turn.status = event.status
        turn.error = event.error
        const open = openText(turn)
        if (open !== -1) {
          // Cancelled mid-sentence: what arrived is kept, but it is not an answer.
          if (event.status === 'completed')
            turn.items[open] = { ...(turn.items[open] as Extract<TurnItem, { kind: 'text' }>), done: true }
          else turn.items.splice(open, 1)
        }
        // An adapter that cannot stream sends nothing until the end; the
        // answer is then shown from here instead. One that streamed it already
        // has it as the last text after the last tool call.
        const lastTool = turn.items.findLastIndex((item) => item.kind === 'tool')
        const streamedAfter = turn.items.slice(lastTool + 1).some((item) => item.kind === 'text')
        if (event.status === 'completed' && event.answer && !streamedAfter) {
          turn.items.push({ kind: 'text', text: event.answer, done: true })
        }
      })
  }
}
