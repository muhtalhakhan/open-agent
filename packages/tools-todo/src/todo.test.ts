import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@open-agent/agent'
import { formatTodos, parseTodos, todoWriteTool, trackTodos, type TodoItem } from './todo.js'

const ctx = { taskId: 't1', signal: new AbortController().signal }
const plan = [
  { content: 'Read the parser', status: 'done' },
  { content: 'Add the failing test', status: 'in_progress' },
  { content: 'Fix it', status: 'pending' },
]

describe('todoWriteTool', () => {
  it('is safe', () => {
    expect(todoWriteTool().permissionLevel).toBe('safe')
  })

  it('accepts a list and returns it as a checklist with progress', async () => {
    expect(await todoWriteTool().execute({ todos: plan }, ctx)).toEqual({
      ok: true,
      content: 'Todo list (1/3 done):\n[x] Read the parser\n[>] Add the failing test\n[ ] Fix it',
    })
  })

  it.each([
    [{ todos: 'x' }, /must be a list/],
    [{ todos: [{ content: '', status: 'pending' }] }, /todo 1 needs content/],
    [{ todos: [{ content: 'a', status: 'blocked' }] }, /status must be one of/],
    [{ todos: [{ content: 'a'.repeat(301), status: 'pending' }] }, /longer than 300/],
    [{ todos: Array.from({ length: 51 }, () => ({ content: 'a', status: 'pending' })) }, /keep it to 50/],
    [
      {
        todos: [
          { content: 'a', status: 'in_progress' },
          { content: 'b', status: 'in_progress' },
        ],
      },
      /only one todo can be in_progress/,
    ],
  ])('refuses %j', async (args, error) => {
    expect(await todoWriteTool().execute(args, ctx)).toMatchObject({ ok: false, error: expect.stringMatching(error) })
  })

  it('trims content', () => {
    expect(parseTodos({ todos: [{ content: '  a  ', status: 'pending' }] })).toEqual({
      ok: true,
      todos: [{ content: 'a', status: 'pending' }],
    })
  })

  it('formats an empty list', () => {
    expect(formatTodos([])).toBe('(empty)')
  })
})

describe('trackTodos', () => {
  const call = (id: string, todos: unknown, taskId = 't1'): SessionEvent => ({
    type: 'tool/call',
    taskId,
    at: 1,
    call: { id, name: 'todo_write', args: { todos } },
  })
  const result = (callId: string, ok: boolean, taskId = 't1'): SessionEvent => ({
    type: 'tool/result',
    taskId,
    at: 2,
    callId,
    result: ok ? { ok, content: '' } : { ok, content: '', error: 'refused' },
  })

  it('reports a list once its call succeeds, per task, and ignores refused calls and other tools', () => {
    const seen: Array<[string, TodoItem[]]> = []
    const track = trackTodos((taskId, todos) => seen.push([taskId, todos]))

    track(call('a', plan))
    expect(seen).toEqual([])
    track(result('a', true))
    track(call('b', [{ content: 'x', status: 'pending' }]))
    track(result('b', false))
    track({ type: 'tool/call', taskId: 't1', at: 3, call: { id: 'c', name: 'read_file', args: {} } })
    track(result('c', true))
    track(call('d', [{ content: 'other task', status: 'pending' }], 't2'))
    track(result('d', true, 't2'))

    expect(seen).toEqual([
      ['t1', plan],
      ['t2', [{ content: 'other task', status: 'pending' }]],
    ])
  })
})
