import { describe, expect, it, vi } from 'vitest'
import type { LlmRequest } from '@open-agent/agent'
import { GeminiProvider } from './gemini.js'
import { recordText, sseResponse } from './sse-fixture.js'

describe('GeminiProvider', () => {
  const mockTools = [
    {
      name: 'get_weather',
      description: 'Get weather',
      schema: { type: 'object', properties: { loc: { type: 'string' } } },
    },
  ]

  it('maps messages, tools, system instruction and generates UUIDs for tool calls', async () => {
    let capturedBody: unknown
    const fetchFn = vi.fn().mockImplementation(async (url, options) => {
      capturedBody = JSON.parse((options.body as string) ?? '{}')
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: 'It is sunny.' }, { functionCall: { name: 'get_weather', args: { loc: 'SF' } } }],
              },
            },
          ],
        }),
      }
    })

    const provider = new GeminiProvider({
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
      fetchFn,
    })

    const request: LlmRequest = {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the weather in NYC?' },
      ],
      tools: mockTools,
    }

    const abortController = new AbortController()
    const response = await provider.generate(request, abortController.signal)

    // Verify URL and headers
    expect(fetchFn).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=test-key',
      expect.objectContaining({ method: 'POST' }),
    )

    // Verify system instruction
    expect(capturedBody).toHaveProperty('systemInstruction')
    expect(
      (capturedBody as { systemInstruction: { role: string; parts: Array<{ text: string }> } }).systemInstruction,
    ).toEqual({
      role: 'user',
      parts: [{ text: 'You are a helpful assistant.' }],
    })

    // Verify tools mapping
    expect(capturedBody).toHaveProperty('tools')
    expect((capturedBody as { tools: Array<{ functionDeclarations: Array<{ name: string }> }> }).tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { loc: { type: 'string' } } },
          },
        ],
      },
    ])

    // Verify message formatting
    expect(capturedBody).toHaveProperty('contents')
    expect((capturedBody as { contents: Array<{ role: string; parts: Array<{ text: string }> }> }).contents).toEqual([
      { role: 'user', parts: [{ text: 'What is the weather in NYC?' }] },
    ])

    // Verify response parsing with UUID generation
    expect(response.message.content).toBe('It is sunny.')
    expect(response.message.toolCalls).toHaveLength(1)
    expect(response.message.toolCalls?.[0].name).toBe('get_weather')
    expect(response.message.toolCalls?.[0].args).toEqual({ loc: 'SF' })
    expect(response.message.toolCalls?.[0].id).toBeDefined()
  })

  it('resolves tool call IDs to names in tool result messages', async () => {
    let capturedBody: unknown
    const fetchFn = vi.fn().mockImplementation(async (url, options) => {
      capturedBody = JSON.parse((options.body as string) ?? '{}')
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'Done.' }] } }] }),
      }
    })

    const provider = new GeminiProvider({
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
      fetchFn,
    })

    const request: LlmRequest = {
      messages: [
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_123', name: 'get_weather', args: { loc: 'NYC' } }] },
        { role: 'tool', content: '65F', toolCallId: 'call_123' },
      ],
      tools: [],
    }

    await provider.generate(request, new AbortController().signal)

    // Verify tool result uses name not ID
    expect(capturedBody).toHaveProperty('contents')
    const contents = (capturedBody as { contents: Array<{ role: string; parts: GeminiPart[] }> }).contents
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'What is the weather?' }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'get_weather', args: { loc: 'NYC' } } }],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { result: '65F' } } }],
      },
    ])
  })

  it('throws on network/api error', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    })

    const provider = new GeminiProvider({
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
      fetchFn,
    })

    await expect(provider.generate({ messages: [], tools: [] }, new AbortController().signal)).rejects.toThrow(
      'generateContent?key=[REDACTED] responded 400: Bad Request',
    )
  })
  describe('streaming', () => {
    it('calls streamGenerateContent over SSE and gathers the parts into one message', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        sseResponse([
          { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'Checking ' }] } }] } },
          { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'the weather…' }] } }] } },
          {
            data: {
              candidates: [
                { content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { loc: 'SF' } } }] } },
              ],
            },
          },
        ]),
      )
      const seen = recordText()
      const result = await new GeminiProvider({ apiKey: 'test-key', model: 'gemini-test', fetchFn }).generate(
        { messages: [{ role: 'user', content: 'weather?' }], tools: [] },
        new AbortController().signal,
        { onText: seen.onText },
      )

      expect(fetchFn.mock.calls[0][0]).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse&key=test-key',
      )
      expect(seen.events).toEqual([
        { type: 'delta', text: 'Checking ' },
        { type: 'delta', text: 'the weather…' },
      ])
      expect(result.message).toMatchObject({
        role: 'assistant',
        content: 'Checking the weather…',
        toolCalls: [{ name: 'get_weather', args: { loc: 'SF' } }],
      })
    })
  })
})

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: { result: string } }
}
