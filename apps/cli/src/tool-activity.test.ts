import { describe, expect, it } from 'vitest'
import type { SessionEvent, ToolCall, ToolResult } from '@open-agent/agent'
import {
  createLineActivityView,
  describeCall,
  describeOutcome,
  formatDuration,
  trackToolActivity,
} from './tool-activity.js'

function recordingView() {
  const seen: string[] = []
  return {
    seen,
    view: {
      started: (call: ToolCall) => void seen.push(`start ${call.id}`),
      finished: (call: ToolCall, result: ToolResult, ms: number) =>
        void seen.push(`end ${call.id} ${result.ok ? 'ok' : result.error} ${ms}`),
    },
  }
}

const call = (id: string, name = 'read_file', args: Record<string, unknown> = {}): ToolCall => ({ id, name, args })

describe('trackToolActivity', () => {
  it('pairs each result with its call by id and times it from the two events', () => {
    const { seen, view } = recordingView()
    const onEvent = trackToolActivity(view)
    const events: SessionEvent[] = [
      { type: 'step/start', taskId: 't', at: 0 },
      { type: 'tool/call', taskId: 't', at: 100, call: call('a') },
      { type: 'tool/result', taskId: 't', at: 142, callId: 'a', result: { ok: true, content: '' } },
      { type: 'tool/call', taskId: 't', at: 150, call: call('b') },
      { type: 'tool/result', taskId: 't', at: 153, callId: 'b', result: { ok: false, content: '', error: 'nope' } },
    ]
    events.forEach(onEvent)

    expect(seen).toEqual(['start a', 'end a ok 42', 'start b', 'end b nope 3'])
  })

  it('finishes a call still open when the turn ends, so nothing is left showing as running', () => {
    const { seen, view } = recordingView()
    const onEvent = trackToolActivity(view)

    onEvent({ type: 'tool/call', taskId: 't', at: 0, call: call('a') })
    onEvent({ type: 'turn/end', taskId: 't', at: 500, reason: 'cancelled' })

    expect(seen).toEqual(['start a', 'end a cancelled 500'])
  })
})

describe('describing calls', () => {
  it('puts the call on one line and clips long arguments', () => {
    expect(describeCall(call('a', 'read_file', { path: 'src/a.ts' }))).toBe('read_file {"path":"src/a.ts"}')
    expect(describeCall(call('a', 'list_windows'))).toBe('list_windows')
    const long = describeCall(call('a', 'write_file', { content: 'x'.repeat(500) }))
    expect(long.length).toBeLessThan(100)
    expect(long.endsWith('…')).toBe(true)
  })

  it('strips terminal escapes from text the model or a tool controls', () => {
    const hasControl = (text: string) =>
      [...text].some((ch) => {
        const code = ch.charCodeAt(0)
        return code < 0x20 || (code >= 0x7f && code <= 0x9f)
      })
    // U+009B is a C1 CSI: JSON.stringify leaves it alone, unlike ESC.
    const evil = '\x1b[2J\x1b]0;pwned\x07\u009b2J'
    expect(hasControl(describeCall(call('a', `shell${evil}`, { cmd: evil })))).toBe(false)
    expect(hasControl(describeOutcome({ ok: false, content: '', error: `bad${evil}\nthing` }, 1))).toBe(false)
  })

  it('reports an outcome with its duration', () => {
    expect(describeOutcome({ ok: true, content: 'x' }, 42)).toBe('ok 42ms')
    expect(describeOutcome({ ok: false, content: '', error: 'no such file' }, 3)).toBe('failed: no such file (3ms)')
    expect(formatDuration(1234)).toBe('1.2s')
  })
})

describe('createLineActivityView', () => {
  it('writes the call when it starts and its outcome, indented, when it ends', () => {
    const writes: string[] = []
    const view = createLineActivityView((text) => writes.push(text))
    const c = call('a', 'read_file', { path: 'a.ts' })

    view.started(c)
    view.finished(c, { ok: true, content: '' }, 7)

    expect(writes.join('')).toBe('▸ read_file {"path":"a.ts"}\n  ok 7ms\n')
  })
})
