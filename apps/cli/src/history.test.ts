import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentLoop, SessionLog, SessionStore, ToolRegistry } from '@open-agent/agent'
import type { LlmAdapter, SessionEvent, TaskRecord } from '@open-agent/agent'
import { formatHistory, sessionHistory } from './history.js'
import { runRepl } from './repl.js'

const echo: LlmAdapter = {
  name: 'echo',
  async generate({ messages }) {
    const user = [...messages].reverse().find((m) => m.role === 'user')
    return { message: { role: 'assistant', content: `you said: ${user?.content ?? ''}` } }
  },
}

const at = (iso: string) => Date.parse(iso)

describe('formatHistory', () => {
  it('shows when, how it ended, the prompt, the answer, and where to resume it', () => {
    const records: TaskRecord[] = [
      {
        taskId: 't2',
        sessionId: 'session_abc',
        prompt: 'summarize\nthe   readme',
        status: 'completed',
        startedAt: at('2026-09-19T14:02:00Z'),
        endedAt: at('2026-09-19T14:03:00Z'),
        answer: 'It is a CLI agent.',
        toolCalls: 1,
      },
      {
        taskId: 't1',
        prompt: 'deploy',
        status: 'error',
        startedAt: at('2026-09-18T09:00:00Z'),
        toolCalls: 3,
      },
    ]

    expect(formatHistory(records, { timeZone: 'UTC' })).toBe(
      [
        '2026-09-19 14:02  completed    summarize the readme',
        '    It is a CLI agent.',
        '    session_abc · 1 tool call',
        '',
        '2026-09-18 09:00  error        deploy',
        '    this session · 3 tool calls',
        '',
        'Reopen a session with: open-agent --resume <session id>',
        '',
      ].join('\n'),
    )
  })

  it('cuts long prompts and answers to one line', () => {
    const [first] = formatHistory(
      [{ taskId: 't', prompt: 'x'.repeat(300), status: 'interrupted', startedAt: 0, toolCalls: 0 }],
      { timeZone: 'UTC' },
    ).split('\n')
    expect(first.endsWith(`${'x'.repeat(99)}…`)).toBe(true)
  })

  it('says so when there is nothing yet', () => {
    expect(formatHistory([])).toBe('No past tasks yet.\n')
  })
})

describe('sessionHistory', () => {
  let base: string
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'cli-history-'))
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const task = (taskId: string, time: number, content: string): SessionEvent[] => [
    { type: 'turn/start', taskId, at: time },
    { type: 'user/message', taskId, at: time, message: { role: 'user', content } },
    { type: 'turn/end', taskId, at: time + 1, reason: 'completed' },
  ]

  it("merges saved sessions with this one's unsaved tasks, newest first", async () => {
    const store = new SessionStore({ base })
    await store.save('session_old', task('old', 100, 'yesterday'), 100)
    const current = new SessionLog()
    for (const event of task('now', 500, 'just now')) current.append(event)

    const records = await sessionHistory(store, current)
    expect(records.map((r) => [r.prompt, r.sessionId])).toEqual([
      ['just now', undefined],
      ['yesterday', 'session_old'],
    ])
  })

  it('lists a resumed session once, from memory rather than disk', async () => {
    const store = new SessionStore({ base })
    const saved = task('t', 100, 'resumed task')
    await store.save('session_r', saved, 100)
    const current = new SessionLog()
    current.loadFrom({ id: 'session_r', createdAt: 100, updatedAt: 100, events: saved })

    const records = await sessionHistory(store, current)
    expect(records.map((r) => r.prompt)).toEqual(['resumed task'])
  })

  it('keeps the session going when :history fails', async () => {
    const sessions = new SessionLog()
    const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm: echo })
    const inputs = [':history', 'after']
    const output: string[] = []
    const io = { prompt: async () => inputs.shift() ?? null, write: (text: string) => void output.push(text) }

    await runRepl(
      loop,
      sessions,
      io,
      { current: null },
      {
        history: async () => {
          throw new Error('EACCES: permission denied')
        },
      },
    )

    expect(output.join('')).toContain('Could not read task history: EACCES: permission denied')
    expect(output.join('')).toContain('you said: after')
  })

  it('backs :history in the interactive session', async () => {
    const store = new SessionStore({ base })
    await store.save('session_old', task('old', 100, 'from before'), 100)
    const sessions = new SessionLog()
    const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm: echo })
    const inputs = ['hello', ':history']
    const output: string[] = []
    const io = { prompt: async () => inputs.shift() ?? null, write: (text: string) => void output.push(text) }

    await runRepl(loop, sessions, io, { current: null }, { history: () => sessionHistory(store, sessions) })

    const listing = output.at(-1) ?? ''
    expect(listing).toMatch(/completed +hello\n {4}you said: hello\n {4}this session/)
    expect(listing).toMatch(/completed +from before/)
    expect(listing.indexOf('hello')).toBeLessThan(listing.indexOf('from before'))
  })
})
