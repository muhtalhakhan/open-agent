import { describe, expect, it } from 'vitest'
import { AgentLoop } from './agent-loop.js'
import { SessionLog } from './session.js'
import { ToolRegistry } from './tools.js'
import type { LlmAdapter, LlmRequest, ToolAttachment, ToolCall } from './types.js'

describe('tool attachments', () => {
  it('reach whoever is watching with the call that made them, and nowhere else', async () => {
    const sessions = new SessionLog()
    const tools = new ToolRegistry()
    tools.register({
      name: 'browser_navigate',
      description: '',
      schema: {},
      permissionLevel: 'safe',
      async execute(_args, context) {
        context.onAttachment?.({ kind: 'image', mimeType: 'image/png', data: 'SECRET-PIXELS', caption: 'page' })
        return { ok: true, content: 'navigated' }
      },
    })
    const requests: LlmRequest[] = []
    const llm: LlmAdapter = {
      name: 'scripted',
      async generate(request) {
        requests.push(request)
        return request.messages.some((m) => m.role === 'tool')
          ? { message: { role: 'assistant', content: 'done' } }
          : {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'browser_navigate', args: {} }],
              },
            }
      },
    }
    const shown: [ToolAttachment, ToolCall][] = []

    await new AgentLoop({ sessions, tools, llm }).run('go', new AbortController().signal, 't1', {
      onAttachment: (attachment, call) => void shown.push([attachment, call]),
    })

    expect(shown).toEqual([
      [
        { kind: 'image', mimeType: 'image/png', data: 'SECRET-PIXELS', caption: 'page' },
        expect.objectContaining({ id: 'c1' }),
      ],
    ])
    expect(JSON.stringify(sessions.allEvents())).not.toContain('SECRET-PIXELS')
    expect(JSON.stringify(requests)).not.toContain('SECRET-PIXELS')
  })

  it('leave a tool with nobody watching nothing to call', async () => {
    let offered: unknown = 'not called'
    const tools = new ToolRegistry()
    tools.register({
      name: 'look',
      description: '',
      schema: {},
      permissionLevel: 'safe',
      async execute(_args, context) {
        offered = context.onAttachment
        return { ok: true, content: '' }
      },
    })
    const llm: LlmAdapter = {
      name: 'scripted',
      async generate({ messages }) {
        return messages.some((m) => m.role === 'tool')
          ? { message: { role: 'assistant', content: 'done' } }
          : { message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'look', args: {} }] } }
      },
    }

    await new AgentLoop({ sessions: new SessionLog(), tools, llm }).run('go', new AbortController().signal)

    expect(offered).toBeUndefined()
  })
})
