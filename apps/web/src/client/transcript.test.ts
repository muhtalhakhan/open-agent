import { describe, expect, it } from 'vitest'
import type { ServerEvent } from '../protocol.js'
import { reduce, type Transcript, type Turn } from './transcript.js'

const fold = (events: ServerEvent[], from: Transcript = []) => events.reduce(reduce, from)
const start: ServerEvent = { type: 'task/start', taskId: 't1', input: 'say hi' }
const delta = (text: string, taskId = 't1'): ServerEvent => ({ type: 'text', taskId, event: { type: 'delta', text } })
const textEnd: ServerEvent = { type: 'text', taskId: 't1', event: { type: 'end' } }
const toolStart: ServerEvent = { type: 'tool/start', taskId: 't1', callId: 'c1', name: 'read_file', args: '{}' }
const completed = (answer: string): ServerEvent => ({ type: 'task/end', taskId: 't1', status: 'completed', answer })

function onlyTurn(state: Transcript): Turn {
  const turn = state.find((entry) => entry.kind === 'turn')
  if (!turn || turn.kind !== 'turn') throw new Error('no turn')
  return turn
}

describe('reduce', () => {
  it('builds a streamed reply up from its deltas and freezes it at the end', () => {
    const state = fold([start, delta('Hel'), delta('lo')])
    expect(onlyTurn(state).items).toEqual([{ kind: 'text', text: 'Hello', done: false }])

    expect(onlyTurn(fold([textEnd], state)).items).toEqual([{ kind: 'text', text: 'Hello', done: true }])
  })

  it('drops a reply the model is retrying', () => {
    const state = fold([start, delta('half a'), { type: 'text', taskId: 't1', event: { type: 'reset' } }, delta('Hi')])

    expect(onlyTurn(state).items).toEqual([{ kind: 'text', text: 'Hi', done: false }])
  })

  it('keeps narration, tool calls and the answer in the order they happened', () => {
    const state = fold([
      start,
      delta('Let me look.'),
      textEnd,
      toolStart,
      { type: 'tool/end', taskId: 't1', callId: 'c1', ok: false, error: 'not approved', ms: 3 },
      delta('It is empty.'),
      textEnd,
      completed('It is empty.'),
    ])

    expect(onlyTurn(state)).toMatchObject({
      status: 'completed',
      items: [
        { kind: 'text', text: 'Let me look.' },
        { kind: 'tool', name: 'read_file', status: 'failed', error: 'not approved', ms: 3 },
        { kind: 'text', text: 'It is empty.' },
      ],
    })
  })

  it('keeps what the task cost', () => {
    const state = fold([start, { ...completed('Hi'), usage: { inputTokens: 50, outputTokens: 2 } } as ServerEvent])

    expect(onlyTurn(state).usage).toEqual({ inputTokens: 50, outputTokens: 2 })
  })

  it('shows the answer from the end event when nothing was streamed', () => {
    const state = fold([start, completed('Hi there')])

    expect(onlyTurn(state).items).toEqual([{ kind: 'text', text: 'Hi there', done: true }])
  })

  it('shows the answer when the only streamed text came before a tool call', () => {
    const state = fold([start, delta('Checking.'), textEnd, toolStart, completed('Found it.')])

    expect(onlyTurn(state).items.at(-1)).toEqual({ kind: 'text', text: 'Found it.', done: true })
  })

  it('discards a half-written reply when the task is cancelled', () => {
    const state = fold([
      start,
      delta('I will now'),
      { type: 'task/end', taskId: 't1', status: 'cancelled', answer: '' },
    ])

    expect(onlyTurn(state)).toMatchObject({ status: 'cancelled', items: [] })
  })

  it('attaches a notice to the running task, and stands it alone otherwise', () => {
    const notice = (text: string): ServerEvent => ({ type: 'notice', text })
    const state = fold([
      notice('Shell sandbox: bubblewrap'),
      start,
      notice('denied "write_file"'),
      completed('ok'),
      notice('later'),
    ])

    expect(state[0]).toEqual({ kind: 'notice', text: 'Shell sandbox: bubblewrap' })
    expect(onlyTurn(state).items[0]).toEqual({ kind: 'notice', text: 'denied "write_file"' })
    expect(state.at(-1)).toEqual({ kind: 'notice', text: 'later' })
  })

  it('starts over on hello, so a reconnect replays into an empty page', () => {
    const state = fold([start, completed('Hi'), { type: 'hello' }])

    expect(state).toEqual([])
  })

  it('ignores events for a task it never saw start', () => {
    const state = fold([start])

    expect(fold([delta('x', 'gone')], state)).toBe(state)
  })

  describe('approvals', () => {
    const request: ServerEvent = {
      type: 'approval/request',
      taskId: 't1',
      approvalId: 'a1',
      tool: 'write_file',
      level: 'ask',
      args: '{}',
      scopes: ['once', 'task', 'session'],
    }

    it('shows a question in the turn, then how it was answered', () => {
      const asked = fold([start, request])
      expect(onlyTurn(asked).items).toEqual([
        {
          kind: 'approval',
          approvalId: 'a1',
          tool: 'write_file',
          level: 'ask',
          args: '{}',
          scopes: ['once', 'task', 'session'],
          state: 'pending',
        },
      ])

      const answered = fold(
        [{ type: 'approval/resolved', taskId: 't1', approvalId: 'a1', approved: true, scope: 'task' }],
        asked,
      )
      expect(onlyTurn(answered).items[0]).toMatchObject({ state: 'approved', scope: 'task' })
    })

    it('never leaves a question pending once its task has ended', () => {
      const state = fold([start, request, { type: 'task/end', taskId: 't1', status: 'cancelled', answer: '' }])

      expect(onlyTurn(state).items[0]).toMatchObject({ state: 'denied' })
    })
  })

  describe('live activity', () => {
    const step = (n: number): ServerEvent => ({ type: 'step', taskId: 't1', step: n })

    it('tracks the step, and marks where each one after the first began', () => {
      const state = fold([start, step(1), toolStart, step(2)])

      expect(onlyTurn(state).step).toBe(2)
      expect(onlyTurn(state).items.map((item) => item.kind)).toEqual(['tool', 'step'])
    })

    it('takes back the half reply a failed attempt streamed, before its reset arrives', () => {
      const state = fold([
        start,
        step(1),
        delta('The answer is'),
        { type: 'retry', taskId: 't1', attempt: 1, reason: '503' },
        { type: 'text', taskId: 't1', event: { type: 'reset' } },
        delta('42'),
      ])

      expect(onlyTurn(state).items).toEqual([
        { kind: 'retry', attempt: 1, reason: '503' },
        { kind: 'text', text: '42', done: false },
      ])
    })

    it('keeps what a tool returned', () => {
      const state = fold([
        start,
        toolStart,
        { type: 'tool/end', taskId: 't1', callId: 'c1', ok: true, output: '# README', ms: 4 },
      ])

      expect(onlyTurn(state).items[0]).toMatchObject({ status: 'ok', output: '# README' })
    })
  })
})
