import { describe, expect, it, vi } from 'vitest'
import type { LlmRequest } from '@open-agent/agent'
import { AnthropicProvider } from './anthropic.js'
import { ProviderHttpError } from './errors.js'
import { recordText, sseResponse } from './sse-fixture.js'
import { IncompleteStreamError } from './sse.js'

describe('AnthropicProvider', () => {
  const mockTools = [
    {
      name: 'get_weather',
      description: 'Get weather',
      schema: { type: 'object', properties: { loc: { type: 'string' } } },
    },
  ]

  it('maps messages, tools, system instruction and parses response', async () => {
    let capturedBody: unknown
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined
    const fetchFn = vi.fn().mockImplementation(async (url, options) => {
      capturedUrl = url
      capturedHeaders = options.headers as Record<string, string>
      capturedBody = JSON.parse((options.body as string) ?? '{}')
      return {
        ok: true,
        json: async () => ({
          content: [
            { type: 'text', text: 'It is sunny.' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { loc: 'SF' } },
          ],
        }),
      }
    })

    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
      fetchFn,
    })

    const request: LlmRequest = {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the weather in NYC?' },
      ],
      tools: mockTools,
    }

    const response = await provider.generate(request, new AbortController().signal)

    // Verify URL and headers
    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages')
    expect(capturedHeaders).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
        'x-api-key': 'test-key',
        'anthropic-version': '2023-06-01',
      }),
    )

    // Verify system instruction
    expect(capturedBody).toHaveProperty('system', 'You are a helpful assistant.')

    // Verify tools mapping
    expect(capturedBody).toHaveProperty('tools')
    expect(
      (capturedBody as { tools: Array<{ name: string; description: string; input_schema: unknown }> }).tools,
    ).toEqual([
      {
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { loc: { type: 'string' } } },
      },
    ])

    // Verify message formatting
    expect(capturedBody).toHaveProperty('messages')
    expect(
      (capturedBody as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }).messages,
    ).toEqual([{ role: 'user', content: [{ type: 'text', text: 'What is the weather in NYC?' }] }])

    // Verify response parsing
    expect(response.message.content).toBe('It is sunny.')
    expect(response.message.toolCalls).toHaveLength(1)
    expect(response.message.toolCalls?.[0].id).toBe('toolu_1')
    expect(response.message.toolCalls?.[0].name).toBe('get_weather')
    expect(response.message.toolCalls?.[0].args).toEqual({ loc: 'SF' })
  })

  it('coalesces consecutive tool results into a single user message', async () => {
    let capturedBody: unknown
    const fetchFn = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse((options.body as string) ?? '{}')
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'Done.' }] }),
      }
    })

    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
      fetchFn,
    })

    const request: LlmRequest = {
      messages: [
        { role: 'user', content: 'Get weather for NYC and SF.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_nyc', name: 'get_weather', args: { loc: 'NYC' } },
            { id: 'call_sf', name: 'get_weather', args: { loc: 'SF' } },
          ],
        },
        { role: 'tool', content: '65F', toolCallId: 'call_nyc' },
        { role: 'tool', content: '70F', toolCallId: 'call_sf' },
      ],
      tools: mockTools,
    }

    await provider.generate(request, new AbortController().signal)

    // Verify both tool results coalesce into a single user message
    expect(capturedBody).toHaveProperty('messages')
    const messages = (
      capturedBody as {
        messages: Array<{ role: string; content: Array<{ type: string; tool_use_id?: string; content?: string }> }>
      }
    ).messages
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Get weather for NYC and SF.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_nyc', name: 'get_weather', input: { loc: 'NYC' } },
          { type: 'tool_use', id: 'call_sf', name: 'get_weather', input: { loc: 'SF' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_nyc', content: '65F', is_error: false },
          { type: 'tool_result', tool_use_id: 'call_sf', content: '70F', is_error: false },
        ],
      },
    ])
  })

  it('concatenates multiple system messages', async () => {
    let capturedBody: unknown
    const fetchFn = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse((options.body as string) ?? '{}')
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'OK' }] }),
      }
    })

    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
      fetchFn,
    })

    const request: LlmRequest = {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' },
      ],
      tools: [],
    }

    await provider.generate(request, new AbortController().signal)

    expect(capturedBody).toHaveProperty('system', 'You are helpful.\n\nBe concise.')
  })

  it('throws on network/api error', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })

    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
      fetchFn,
    })

    await expect(provider.generate({ messages: [], tools: [] }, new AbortController().signal)).rejects.toThrow(
      'https://api.anthropic.com/v1/messages responded 401: Unauthorized',
    )
  })

  describe('streaming', () => {
    const request: LlmRequest = { messages: [{ role: 'user', content: 'weather?' }], tools: mockTools }

    it('reports text deltas and rebuilds the same message the plain call returns', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        sseResponse([
          { event: 'message_start', data: { type: 'message_start', message: { content: [] } } },
          {
            event: 'content_block_start',
            data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          },
          { event: 'ping', data: { type: 'ping' } },
          {
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It is ' } },
          },
          {
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sunny ☀.' } },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"loc":' },
            },
          },
          {
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"SF"}' } },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      )
      const seen = recordText()
      const result = await new AnthropicProvider({ apiKey: 'k', model: 'm', fetchFn }).generate(
        request,
        new AbortController().signal,
        { onText: seen.onText },
      )

      expect(JSON.parse(fetchFn.mock.calls[0][1].body).stream).toBe(true)
      expect(seen.text()).toBe('It is sunny ☀.')
      expect(result.message).toEqual({
        role: 'assistant',
        content: 'It is sunny ☀.',
        toolCalls: [{ id: 'toolu_1', name: 'get_weather', args: { loc: 'SF' } }],
      })
    })

    it('turns a mid-stream overload into a 529, so the fallback adapter still routes around it', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
          ]),
        )
      const err = await new AnthropicProvider({ apiKey: 'k', model: 'm', fetchFn })
        .generate(request, new AbortController().signal, { onText: () => {} })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ProviderHttpError)
      expect((err as ProviderHttpError).status).toBe(529)
    })

    it('rejects a stream that closes before message_stop', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        sseResponse([
          {
            event: 'content_block_start',
            data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          },
          {
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It is' } },
          },
        ]),
      )
      await expect(
        new AnthropicProvider({ apiKey: 'k', model: 'm', fetchFn }).generate(request, new AbortController().signal, {
          onText: () => {},
        }),
      ).rejects.toBeInstanceOf(IncompleteStreamError)
    })
  })
})
