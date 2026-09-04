import { describe, expect, it, vi, type Mock } from 'vitest'
import type { LlmAdapter, LlmResponse } from '@open-agent/agent'
import { ProviderFallbackAdapter } from './fallback-provider.js'

const mockResponse = (): LlmResponse => ({
  message: { role: 'assistant', content: 'ok' },
})

const makeAdapter = (
  name: string,
  fail?: { message: string },
): { adapter: LlmAdapter; fn: Mock<(...args: unknown[]) => unknown> } => {
  const fn = vi.fn() as Mock<(...args: unknown[]) => unknown>
  if (fail) {
    fn.mockRejectedValueOnce(new Error(fail.message))
  }
  fn.mockResolvedValue(mockResponse())
  return {
    adapter: { name, generate: fn } as unknown as LlmAdapter,
    fn,
  }
}

describe('ProviderFallbackAdapter', () => {
  it('returns result from first healthy provider', async () => {
    const bad = makeAdapter('bad', { message: '429 Rate limit' })
    const good = makeAdapter('good')
    const fb = new ProviderFallbackAdapter({ adapters: [bad.adapter, good.adapter] })

    const res = await fb.generate({ messages: [], tools: [] }, new AbortController().signal)

    expect(res.message.content).toBe('ok')
    expect(good.fn).toHaveBeenCalled()
  })

  it('skips exhausted provider and falls through to the next', async () => {
    const broken = makeAdapter('broken', { message: '429 Rate limit' })
    const ok = makeAdapter('ok')
    const fb = new ProviderFallbackAdapter({ adapters: [broken.adapter, ok.adapter] })

    const res = await fb.generate({ messages: [], tools: [] }, new AbortController().signal)

    expect(res.message.content).toBe('ok')
    expect(ok.fn).toHaveBeenCalled()
  })

  it('skips 401 and 403 as fallback triggers', async () => {
    const a = makeAdapter('auth-fail', { message: '401 Unauthorized' })
    const b = makeAdapter('auth-fail2', { message: '403 Forbidden' })
    const ok = makeAdapter('ok')
    const fb = new ProviderFallbackAdapter({ adapters: [a.adapter, b.adapter, ok.adapter] })

    const res = await fb.generate({ messages: [], tools: [] }, new AbortController().signal)

    expect(res.message.content).toBe('ok')
    expect(a.fn).toHaveBeenCalled()
    expect(b.fn).toHaveBeenCalled()
    expect(ok.fn).toHaveBeenCalled()
  })

  it('re-throws non-fallbackable errors immediately', async () => {
    const fail = makeAdapter('fail', { message: '500 Internal Server Error' })
    const ok = makeAdapter('ok')
    const fb = new ProviderFallbackAdapter({ adapters: [fail.adapter, ok.adapter] })

    await expect(fb.generate({ messages: [], tools: [] }, new AbortController().signal)).rejects.toThrow(
      'Internal Server Error',
    )
    expect(ok.fn).not.toHaveBeenCalled()
  })

  it('throws when all providers are exhausted', async () => {
    const a = makeAdapter('a', { message: '429' })
    const b = makeAdapter('b', { message: '401' })
    const fb = new ProviderFallbackAdapter({ adapters: [a.adapter, b.adapter] })

    await expect(fb.generate({ messages: [], tools: [] }, new AbortController().signal)).rejects.toThrow(
      'all providers exhausted',
    )
  })

  it('throws when no adapters provided', async () => {
    const fb = new ProviderFallbackAdapter({ adapters: [] })
    await expect(fb.generate({ messages: [], tools: [] }, new AbortController().signal)).rejects.toThrow(
      'no providers in fallback',
    )
  })

  it('notifies on switch', async () => {
    const notifications: string[] = []
    const broken = makeAdapter('primary', { message: '429' })
    const good = makeAdapter('fallback')
    const fb = new ProviderFallbackAdapter({
      adapters: [broken.adapter, good.adapter],
      notify: (msg) => notifications.push(msg),
    })

    await fb.generate({ messages: [], tools: [] }, new AbortController().signal)

    expect(notifications).toContain('provider primary failed (429), trying fallback')
  })

  it('does not notify on success with no switch needed', async () => {
    const notifications: string[] = []
    const good = makeAdapter('good')
    const fb = new ProviderFallbackAdapter({
      adapters: [good.adapter],
      notify: (msg) => notifications.push(msg),
    })

    await fb.generate({ messages: [], tools: [] }, new AbortController().signal)

    expect(notifications).toHaveLength(0)
  })

  // With stateless per-call rotation (no shared mutable index), each call
  // independently tries adapters starting from the first. Rotation between
  // sequential calls is not preserved — this is the intentional fix for the
  // concurrent-race bug (fallback-provider.ts line 10/25).
  it('uses stateless rotation (always starts at first adapter per call)', async () => {
    const a = makeAdapter('a')
    const b = makeAdapter('b')
    const fb = new ProviderFallbackAdapter({ adapters: [a.adapter, b.adapter] })
    await fb.generate({ messages: [], tools: [] }, new AbortController().signal)
    expect(a.fn).toHaveBeenCalled()
    await fb.generate({ messages: [], tools: [] }, new AbortController().signal)
    expect(a.fn).toHaveBeenCalledTimes(2) // stateless: starts at a again
  })

  it('does not notify when the first adapter succeeds outright', async () => {
    const notifications: string[] = []
    const a = makeAdapter('a')
    const b = makeAdapter('b')
    const fb = new ProviderFallbackAdapter({
      adapters: [a.adapter, b.adapter],
      notify: (msg) => notifications.push(msg),
    })

    await fb.generate({ messages: [], tools: [] }, new AbortController().signal)

    expect(notifications).toHaveLength(0)
  })

  it('names the adapter it started from when reporting a switch', async () => {
    const notifications: string[] = []
    const a = makeAdapter('a', { message: '429 Rate limit' })
    const b = makeAdapter('b')
    const fb = new ProviderFallbackAdapter({
      adapters: [a.adapter, b.adapter],
      notify: (msg) => notifications.push(msg),
    })

    await fb.generate({ messages: [], tools: [] }, new AbortController().signal)

    expect(notifications).toContain('switched from a to b')
  })

  it('does not treat 400 as a fallback trigger', async () => {
    const bad = makeAdapter('bad', { message: 'provider responded 400: Bad Request' })
    const ok = makeAdapter('ok')
    const fb = new ProviderFallbackAdapter({ adapters: [bad.adapter, ok.adapter] })

    await expect(fb.generate({ messages: [], tools: [] }, new AbortController().signal)).rejects.toThrow(
      'responded 400',
    )
    expect(ok.fn).not.toHaveBeenCalled()
  })

  it('does not fall back on a non-rate-limit error that merely contains 429', async () => {
    const bad = makeAdapter('bad', { message: 'provider responded 500 (request id req_4291a)' })
    const ok = makeAdapter('ok')
    const fb = new ProviderFallbackAdapter({ adapters: [bad.adapter, ok.adapter] })

    await expect(fb.generate({ messages: [], tools: [] }, new AbortController().signal)).rejects.toThrow(
      'responded 500',
    )
    expect(ok.fn).not.toHaveBeenCalled()
  })

  it('aborts during backoff instead of waiting out the delay', async () => {
    const a = makeAdapter('a', { message: '429 Rate limit' })
    const b = makeAdapter('b')
    const fb = new ProviderFallbackAdapter({ adapters: [a.adapter, b.adapter] })
    const ctrl = new AbortController()

    const pending = fb.generate({ messages: [], tools: [] }, ctrl.signal)
    ctrl.abort(new Error('cancelled by caller'))

    await expect(pending).rejects.toThrow('cancelled by caller')
    expect(b.fn).not.toHaveBeenCalled()
  })

  it('carries the last provider error as `cause` when all are exhausted', async () => {
    const a = makeAdapter('a', { message: 'provider responded 429: rate limited' })
    const b = makeAdapter('b', { message: 'provider responded 401: bad api key' })
    const fb = new ProviderFallbackAdapter({ adapters: [a.adapter, b.adapter] })

    const err = await fb.generate({ messages: [], tools: [] }, new AbortController().signal).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('all providers exhausted')
    expect(((err as Error).cause as Error).message).toContain('401')
  })
})
