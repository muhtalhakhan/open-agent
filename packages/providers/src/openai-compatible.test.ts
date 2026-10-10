import { describe, expect, it, vi } from 'vitest'
import { OpenAiCompatibleProvider } from './openai-compatible.js'
import { recordText, sseResponse } from './sse-fixture.js'

function fakeFetch(responseBody: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  })
}

describe('OpenAiCompatibleProvider', () => {
  it('sends messages and tool schemas in the OpenAI chat-completions shape', async () => {
    const fetchFn = fakeFetch({ choices: [{ message: { content: 'hi there' } }] })
    const provider = new OpenAiCompatibleProvider({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchFn,
    })

    await provider.generate(
      {
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'echo', description: 'echoes', schema: { type: 'object', properties: {} } }],
      },
      new AbortController().signal,
    )

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
      }),
    )
    const body = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(body.model).toBe('gpt-test')
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'echo', description: 'echoes', parameters: { type: 'object', properties: {} } },
      },
    ])
  })

  it('parses a plain text response into an assistant message', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchFn: fakeFetch({ choices: [{ message: { content: 'the answer is 42' } }] }),
    })
    const result = await provider.generate({ messages: [], tools: [] }, new AbortController().signal)
    expect(result.message).toEqual({ role: 'assistant', content: 'the answer is 42', toolCalls: undefined })
  })

  it('parses a tool-call response into ToolCall objects', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchFn: fakeFetch({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'call_1', function: { name: 'web_search', arguments: '{"query":"AI news"}' } }],
            },
          },
        ],
      }),
    })
    const result = await provider.generate({ messages: [], tools: [] }, new AbortController().signal)
    expect(result.message).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'web_search', args: { query: 'AI news' } }],
    })
  })

  it('round-trips a tool-result message back to the tool role with tool_call_id', async () => {
    const fetchFn = fakeFetch({ choices: [{ message: { content: 'ok' } }] })
    const provider = new OpenAiCompatibleProvider({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchFn,
    })
    await provider.generate(
      { messages: [{ role: 'tool', content: 'search results', toolCallId: 'call_1' }], tools: [] },
      new AbortController().signal,
    )
    const body = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(body.messages).toEqual([{ role: 'tool', content: 'search results', tool_call_id: 'call_1' }])
  })

  it('throws with the response body when the request fails', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-bad',
      model: 'gpt-test',
      fetchFn: fakeFetch({ error: 'invalid api key' }, false, 401),
    })
    await expect(provider.generate({ messages: [], tools: [] }, new AbortController().signal)).rejects.toThrow(/401/)
  })

  describe('streaming', () => {
    const options = (fetchFn: unknown) => ({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchFn: fetchFn as typeof fetch,
    })

    it('asks for a stream only when someone is listening', async () => {
      const fetchFn = fakeFetch({ choices: [{ message: { content: 'hi' } }] })
      const provider = new OpenAiCompatibleProvider(options(fetchFn))
      await provider.generate({ messages: [], tools: [] }, new AbortController().signal)
      await provider.generate({ messages: [], tools: [] }, new AbortController().signal, { onText: () => {} })
      expect(JSON.parse(fetchFn.mock.calls[0][1].body).stream).toBeUndefined()
      expect(JSON.parse(fetchFn.mock.calls[1][1].body).stream).toBe(true)
    })

    it('reports text as it arrives and resolves with the same message the plain call returns', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            { data: { choices: [{ delta: { role: 'assistant', content: '' } }] } },
            { data: { choices: [{ delta: { content: 'Le café ' } }] } },
            { data: { choices: [{ delta: { content: 'est ✓' } }] } },
            { data: { choices: [{ delta: {} }] } },
            { data: '[DONE]' },
          ]),
        )
      const seen = recordText()
      const result = await new OpenAiCompatibleProvider(options(fetchFn)).generate(
        { messages: [], tools: [] },
        new AbortController().signal,
        { onText: seen.onText },
      )
      expect(seen.events).toEqual([
        { type: 'delta', text: 'Le café ' },
        { type: 'delta', text: 'est ✓' },
      ])
      expect(result.message).toEqual({ role: 'assistant', content: 'Le café est ✓', toolCalls: undefined })
    })

    it('reassembles tool calls whose arguments arrive in fragments', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        sseResponse([
          {
            data: {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '' } }],
                  },
                },
              ],
            },
          },
          { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] } },
          {
            data: {
              choices: [
                { delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'echo', arguments: '{}' } }] } },
              ],
            },
          },
          { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"AI news"}' } }] } }] } },
          { data: '[DONE]' },
        ]),
      )
      const seen = recordText()
      const result = await new OpenAiCompatibleProvider(options(fetchFn)).generate(
        { messages: [], tools: [] },
        new AbortController().signal,
        { onText: seen.onText },
      )
      expect(seen.events).toEqual([])
      expect(result.message).toEqual({
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'web_search', args: { query: 'AI news' } },
          { id: 'call_2', name: 'echo', args: {} },
        ],
      })
    })

    it('falls back to the JSON body when the server ignores stream: true', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'all at once' } }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      const seen = recordText()
      const result = await new OpenAiCompatibleProvider(options(fetchFn)).generate(
        { messages: [], tools: [] },
        new AbortController().signal,
        { onText: seen.onText },
      )
      expect(result.message.content).toBe('all at once')
      expect(seen.events).toEqual([])
    })

    it('throws on an error reported mid-stream', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            { data: { choices: [{ delta: { content: 'Hal' } }] } },
            { data: { error: { message: 'upstream died' } } },
          ]),
        )
      await expect(
        new OpenAiCompatibleProvider(options(fetchFn)).generate(
          { messages: [], tools: [] },
          new AbortController().signal,
          {
            onText: () => {},
          },
        ),
      ).rejects.toThrow(/upstream died/)
    })
  })
})
