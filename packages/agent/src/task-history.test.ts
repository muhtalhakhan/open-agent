import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentLoop } from './agent-loop.js'
import { SessionLog } from './session.js'
import { SessionStore } from './session-store.js'
import { readTaskHistory, taskRecords } from './task-history.js'
import { ToolRegistry } from './tools.js'
import type { LlmAdapter, SessionEvent } from './types.js'

/** Answers with a tool call first when the prompt says so, then with "done: <prompt>". */
function scriptedLlm(): LlmAdapter {
  return {
    name: 'scripted',
    async generate({ messages }) {
      const prompt = messages.find((m) => m.role === 'user')?.content ?? ''
      if (prompt === 'fail') throw new Error('provider down')
      const usedTool = messages.some((m) => m.role === 'tool')
      if (prompt.startsWith('use a tool') && !usedTool) {
        return { message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'echo', args: {} }] } }
      }
      return { message: { role: 'assistant', content: `done: ${prompt}` } }
    },
  }
}

function agent() {
  const sessions = new SessionLog()
  const tools = new ToolRegistry()
  tools.register({
    name: 'echo',
    description: '',
    schema: {},
    permissionLevel: 'safe',
    execute: async () => ({ ok: true, content: 'echoed' }),
  })
  return { sessions, loop: new AgentLoop({ sessions, tools, llm: scriptedLlm(), maxRetries: 0 }) }
}

describe('taskRecords', () => {
  it('describes each task from what the log recorded', async () => {
    const { sessions, loop } = agent()
    await loop.run('summarize the readme', new AbortController().signal, 't1')
    await loop.run('use a tool please', new AbortController().signal, 't2')
    await loop.run('fail', new AbortController().signal, 't3')

    const records = taskRecords(sessions.allEvents(), 'session_a')

    expect(records).toMatchObject([
      { taskId: 't1', sessionId: 'session_a', prompt: 'summarize the readme', status: 'completed', toolCalls: 0 },
      {
        taskId: 't2',
        prompt: 'use a tool please',
        status: 'completed',
        answer: 'done: use a tool please',
        toolCalls: 1,
      },
      { taskId: 't3', prompt: 'fail', status: 'error' },
    ])
    expect(records[0].answer).toBe('done: summarize the readme')
    expect(records[2].answer).toBeUndefined()
    expect(records[0].endedAt).toBeGreaterThanOrEqual(records[0].startedAt)
  })

  it('records a cancelled task as cancelled, with no answer', async () => {
    const { sessions, loop } = agent()
    const controller = new AbortController()
    controller.abort()
    await loop.run('never mind', controller.signal, 't1')
    const [record] = taskRecords(sessions.allEvents())
    expect(record.status).toBe('cancelled')
    expect(record.answer).toBeUndefined()
  })

  it('calls a task whose last turn never ended interrupted, even when timestamps tie', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', taskId: 't', at: 5 },
      { type: 'user/message', taskId: 't', at: 5, message: { role: 'user', content: 'first' } },
      { type: 'assistant/message', taskId: 't', at: 5, message: { role: 'assistant', content: 'ok' } },
      { type: 'turn/end', taskId: 't', at: 5, reason: 'completed' },
      // A second turn on the same task, begun in the same millisecond and cut off.
      { type: 'turn/start', taskId: 't', at: 5 },
      { type: 'user/message', taskId: 't', at: 5, message: { role: 'user', content: 'second' } },
    ]
    const [record] = taskRecords(events)
    expect(record).toMatchObject({ prompt: 'first', status: 'interrupted' })
    expect(record.endedAt).toBeUndefined()
    expect(record.answer).toBeUndefined()
  })

  it('skips a task nobody asked for', () => {
    const events: SessionEvent[] = [
      { type: 'system/message', taskId: 'x', at: 1, message: { role: 'system', content: 'conventions' } },
    ]
    expect(taskRecords(events)).toEqual([])
  })
})

describe('readTaskHistory', () => {
  let base: string
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'task-history-'))
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const event = (taskId: string, at: number, content: string): SessionEvent[] => [
    { type: 'turn/start', taskId, at },
    { type: 'user/message', taskId, at, message: { role: 'user', content } },
    { type: 'turn/end', taskId, at: at + 1, reason: 'completed' },
  ]

  it('returns the newest tasks across sessions, newest first, up to the limit', async () => {
    const store = new SessionStore({ base })
    await store.save('session_old', [...event('a', 100, 'a'), ...event('b', 200, 'b')], 100)
    await store.save('session_new', [...event('c', 300, 'c'), ...event('d', 400, 'd')], 300)

    const history = await readTaskHistory(store, { limit: 3 })
    expect(history.map((r) => [r.prompt, r.sessionId])).toEqual([
      ['d', 'session_new'],
      ['c', 'session_new'],
      ['b', 'session_old'],
    ])
  })

  it('does not let a resumed old session crowd out newer tasks', async () => {
    const store = new SessionStore({ base })
    await store.save('session_recent', event('new', 900, 'yesterday'), 900)
    // Saved last, so it sorts first by write time, but its tasks are old.
    await store.save('session_resumed', [...event('o1', 10, 'old 1'), ...event('o2', 20, 'old 2')], 10)

    const history = await readTaskHistory(store, { limit: 1 })
    expect(history.map((r) => r.prompt)).toEqual(['yesterday'])
  })

  it('filters by outcome', async () => {
    const store = new SessionStore({ base })
    await store.save(
      'session_x',
      [
        ...event('a', 1, 'fine'),
        { type: 'turn/start', taskId: 'b', at: 5 },
        { type: 'user/message', taskId: 'b', at: 5, message: { role: 'user', content: 'broken' } },
        { type: 'turn/end', taskId: 'b', at: 6, reason: 'error' },
      ],
      1,
    )
    const history = await readTaskHistory(store, { status: 'error' })
    expect(history.map((r) => r.prompt)).toEqual(['broken'])
  })

  it('skips a session it cannot read, says which, and still returns the rest', async () => {
    const store = new SessionStore({ base })
    await store.save('session_good', event('a', 1, 'still here'), 1)
    await store.save('session_bad', event('b', 2, 'lost'), 2)
    await writeFile(path.join(base, 'session_bad', 'session.json'), '{"id": "session_bad", "events": [', 'utf8')

    const skipped: string[] = []
    const history = await readTaskHistory(store, { onUnreadable: (id) => void skipped.push(id) })

    expect(history.map((r) => r.prompt)).toEqual(['still here'])
    expect(skipped).toEqual(['session_bad'])
  })

  it('is empty when nothing has been saved', async () => {
    expect(await readTaskHistory(new SessionStore({ base: path.join(base, 'none') }))).toEqual([])
  })
})
