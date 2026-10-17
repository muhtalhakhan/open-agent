import { describe, expect, it } from 'vitest'
import { AgentLoop, SessionLog, ToolRegistry } from '@open-agent/agent'
import type { LlmAdapter, SessionEvent } from '@open-agent/agent'
import { replayTask } from './project.js'

/** Calls `read_file` once, then answers; reports usage on both replies. */
const llm: LlmAdapter = {
  name: 'scripted',
  async generate({ messages }) {
    const usage = { inputTokens: 100, outputTokens: 5 }
    if (!messages.some((m) => m.role === 'tool')) {
      return {
        message: {
          role: 'assistant',
          content: 'Let me look.',
          toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a' } }],
        },
        usage,
      }
    }
    return { message: { role: 'assistant', content: 'It says hello.' }, usage }
  },
}

async function loggedTask(): Promise<SessionEvent[]> {
  const sessions = new SessionLog()
  const tools = new ToolRegistry()
  tools.register({
    name: 'read_file',
    description: '',
    schema: {},
    permissionLevel: 'safe',
    execute: async () => ({ ok: true, content: 'hello' }),
  })
  await new AgentLoop({ sessions, tools, llm }).run('what does a say?', new AbortController().signal, 't1')
  return sessions.allEvents()
}

describe('replayTask', () => {
  it('replays a logged task as the events the live stream sent for it', async () => {
    const events = replayTask('t1', await loggedTask())

    expect(events.map((event) => event.type)).toEqual([
      'task/start',
      'step',
      'text',
      'text',
      'tool/start',
      'tool/end',
      'step',
      'text',
      'text',
      'task/end',
    ])
    expect(events.filter((event) => event.type === 'step')).toEqual([
      { type: 'step', taskId: 't1', step: 1 },
      { type: 'step', taskId: 't1', step: 2 },
    ])
    expect(events[5]).toMatchObject({ type: 'tool/end', ok: true, output: 'hello' })
    expect(events[0]).toEqual({ type: 'task/start', taskId: 't1', input: 'what does a say?' })
    expect(events[4]).toMatchObject({ name: 'read_file', args: '{"path":"a"}' })
    expect(events.at(-1)).toEqual({
      type: 'task/end',
      taskId: 't1',
      status: 'completed',
      answer: 'It says hello.',
      usage: { inputTokens: 200, outputTokens: 10 },
    })
  })

  it('leaves out other tasks and system messages', async () => {
    const events: SessionEvent[] = [
      { type: 'system/message', taskId: 't1', at: 1, message: { role: 'system', content: 'conventions' } },
      { type: 'user/message', taskId: 'other', at: 2, message: { role: 'user', content: 'not this one' } },
      { type: 'user/message', taskId: 't1', at: 3, message: { role: 'user', content: 'this one' } },
      { type: 'turn/end', taskId: 't1', at: 4, reason: 'cancelled' },
    ]

    expect(replayTask('t1', events)).toEqual([
      { type: 'task/start', taskId: 't1', input: 'this one' },
      { type: 'task/end', taskId: 't1', status: 'cancelled', answer: '' },
    ])
  })

  it('closes a turn the log never closed as interrupted, rather than running forever', () => {
    const events: SessionEvent[] = [
      { type: 'user/message', taskId: 't1', at: 1, message: { role: 'user', content: 'go' } },
      { type: 'tool/call', taskId: 't1', at: 2, call: { id: 'c1', name: 'run_command', args: {} } },
    ]

    expect(replayTask('t1', events).at(-1)).toMatchObject({
      type: 'task/end',
      status: 'error',
      error: 'interrupted: no outcome was recorded',
    })
  })

  it('says what the decision layer chose for the turn', () => {
    const events: SessionEvent[] = [
      { type: 'user/message', taskId: 't1', at: 1, message: { role: 'user', content: 'go' } },
      { type: 'turn/decision', taskId: 't1', at: 2, tools: ['read_file'], llm: 'light' },
      { type: 'turn/end', taskId: 't1', at: 3, reason: 'completed' },
    ]

    expect(replayTask('t1', events)[1]).toEqual({
      type: 'notice',
      text: 'Decision layer: 1 tool offered, light model.',
    })
  })

  it('reports a retry with its reason, and counts steps from 1 again in each turn', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', taskId: 't1', at: 0 },
      { type: 'user/message', taskId: 't1', at: 1, message: { role: 'user', content: 'go' } },
      { type: 'step/start', taskId: 't1', at: 2 },
      { type: 'retry', taskId: 't1', at: 3, attempt: 1, reason: '503 Service Unavailable' },
      { type: 'turn/end', taskId: 't1', at: 4, reason: 'completed' },
      { type: 'turn/start', taskId: 't1', at: 5 },
      { type: 'user/message', taskId: 't1', at: 6, message: { role: 'user', content: 'again' } },
      { type: 'step/start', taskId: 't1', at: 7 },
      { type: 'turn/end', taskId: 't1', at: 8, reason: 'completed' },
    ]

    const replayed = replayTask('t1', events)

    expect(replayed).toContainEqual({ type: 'retry', taskId: 't1', attempt: 1, reason: '503 Service Unavailable' })
    expect(replayed.filter((event) => event.type === 'step').map((event) => (event as { step: number }).step)).toEqual([
      1, 1,
    ])
  })
})
