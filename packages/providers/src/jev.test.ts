import { describe, expect, it, vi } from 'vitest'
import type { DecisionRequest } from '@open-agent/agent'
import { ProviderHttpError } from './errors.js'
import { JevDecisionModel } from './jev.js'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const request: DecisionRequest = {
  evidence: { items: { a: 'TypeError in parser', b: 'timeout talking to registry' } },
  questions: {
    kind: { type: 'choice', instructions: 'What is `items.a`?', options: { bug: 'A defect', flaky: null } },
    real: { type: 'yesno', instructions: 'Is `items.b` a real failure?', yes: 'Code is wrong' },
    severity: { type: 'score', instructions: 'How severe is `items.a`?', levels: ['low', 'medium', 'high'] },
  },
}

describe('JevDecisionModel', () => {
  it('sends the evidence as state and each question in its Jev shape', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ model: 'jev-1', answers: {} }))

    await new JevDecisionModel({ apiKey: 'ts_key', fetchFn }).decide(request, new AbortController().signal)

    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(init.headers.Authorization).toBe('Bearer ts_key')
    expect(JSON.parse(init.body)).toEqual({
      model: 'jev-latest',
      state: request.evidence,
      questions: {
        kind: { type: 'choice', instructions: 'What is `items.a`?', criteria: { bug: 'A defect', flaky: null } },
        real: { type: 'noul', instructions: 'Is `items.b` a real failure?', criteria: { true: 'Code is wrong' } },
        severity: { type: 'score', instructions: 'How severe is `items.a`?', criteria: ['low', 'medium', 'high'] },
      },
    })
  })

  it('returns typed answers and the usage it reported', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      json({
        model: 'jev-1',
        answers: {
          kind: { type: 'choice', choice: 'bug', probabilities: { bug: 0.9, flaky: 0.1 }, confidence: 0.8 },
          real: { type: 'noul', noul: 0.2 },
          severity: { type: 'score', score: 1.6, confidence: 0.7, legend: {} },
        },
        usage: { input_tokens: 400, output_tokens: 3 },
      }),
    )

    const result = await new JevDecisionModel({ apiKey: 'k', fetchFn }).decide(request, new AbortController().signal)

    expect(result).toEqual({
      answers: {
        kind: { type: 'choice', choice: 'bug', probabilities: { bug: 0.9, flaky: 0.1 }, confidence: 0.8 },
        real: { type: 'yesno', probability: 0.2 },
        severity: { type: 'score', score: 1.6, confidence: 0.7 },
      },
      usage: { inputTokens: 400, outputTokens: 3 },
    })
  })

  it('leaves out an answer of the wrong shape, or a choice that was never offered, rather than guessing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      json({
        answers: {
          kind: { type: 'choice', choice: 'infra', probabilities: { infra: 1 } },
          real: { type: 'score', score: 1 },
          severity: { type: 'score' },
        },
      }),
    )

    const result = await new JevDecisionModel({ apiKey: 'k', fetchFn }).decide(request, new AbortController().signal)

    expect(result.answers).toEqual({})
  })

  it('retries a rate limit, waiting as long as the server asks', async () => {
    const waits: number[] = []
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'slow down' }, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(json({ answers: { real: { type: 'noul', noul: 0.9 } } }))

    const result = await new JevDecisionModel({
      apiKey: 'k',
      fetchFn,
      sleep: async (ms) => void waits.push(ms),
    }).decide(request, new AbortController().signal)

    expect(waits).toEqual([2000])
    expect(result.answers.real).toEqual({ type: 'yesno', probability: 0.9 })
  })

  it('fails at once on a request error, and after the retries on a persistent outage', async () => {
    const bad = vi.fn().mockResolvedValue(json({ message: 'bad questions' }, 400))
    await expect(
      new JevDecisionModel({ apiKey: 'k', fetchFn: bad }).decide(request, new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderHttpError)
    expect(bad).toHaveBeenCalledTimes(1)

    const down = vi.fn().mockImplementation(async () => json({}, 503))
    await expect(
      new JevDecisionModel({ apiKey: 'k', fetchFn: down, maxRetries: 2, sleep: async () => {} }).decide(
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 503 })
    expect(down).toHaveBeenCalledTimes(3)
  })

  it('refuses a request too large for the model before paying for it', async () => {
    const fetchFn = vi.fn()

    await expect(
      new JevDecisionModel({ apiKey: 'k', fetchFn }).decide(
        { evidence: 'x'.repeat(130_000), questions: { q: { type: 'yesno', instructions: '?' } } },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Send fewer or shorter items')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does not start when already cancelled', async () => {
    const fetchFn = vi.fn()
    const controller = new AbortController()
    controller.abort()

    await expect(new JevDecisionModel({ apiKey: 'k', fetchFn }).decide(request, controller.signal)).rejects.toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
