import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '@open-agent/agent'
import { httpRequestTool } from './http-request.js'

const ctx = { taskId: 't1', signal: new AbortController().signal }

function jsonFetch(body: unknown, init: ResponseInit = {}) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        statusText: init.statusText ?? '',
        headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
      }),
  )
}

describe('httpRequestTool', () => {
  it('is gated behind approval', async () => {
    expect(httpRequestTool({ lookupFn: null }).permissionLevel).toBe('ask')
  })

  it('sends the request and returns status, headers and body', async () => {
    const fetchFn = jsonFetch({ ok: true })
    const tool = httpRequestTool({ lookupFn: null, fetchFn: fetchFn as unknown as typeof fetch })

    const result = await tool.execute(
      { url: 'https://api.example.com/v1/things', method: 'post', headers: { accept: 'application/json' }, body: '{}' },
      ctx,
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('HTTP 200')
    expect(result.content).toContain('content-type: application/json')
    expect(result.content).toContain('{"ok":true}')
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/v1/things',
      expect.objectContaining({ method: 'POST', headers: { accept: 'application/json' }, body: '{}' }),
    )
  })

  it('defaults to GET', async () => {
    const fetchFn = jsonFetch({})
    await httpRequestTool({ lookupFn: null, fetchFn: fetchFn as unknown as typeof fetch }).execute(
      { url: 'https://x.test/' },
      ctx,
    )
    expect((fetchFn.mock.calls[0] as unknown[])[1]).toMatchObject({ method: 'GET' })
  })

  it('reports a non-2xx as a failure but still hands over the body', async () => {
    const fetchFn = jsonFetch({ message: 'nope' }, { status: 404, statusText: 'Not Found' })
    const result = await httpRequestTool({ lookupFn: null, fetchFn: fetchFn as unknown as typeof fetch }).execute(
      { url: 'https://x.test/missing' },
      ctx,
    )
    expect(result).toMatchObject({ ok: false, error: 'HTTP 404' })
    expect(result.content).toContain('nope')
  })

  it('refuses a host outside the allowlist without making the call', async () => {
    const fetchFn = jsonFetch({})
    const tool = httpRequestTool({
      lookupFn: null,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ['api.example.com'],
    })
    const result = await tool.execute({ url: 'https://evil.test/steal' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not in the allowed host list/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a non-http scheme', async () => {
    const fetchFn = jsonFetch({})
    const result = await httpRequestTool({ lookupFn: null, fetchFn: fetchFn as unknown as typeof fetch }).execute(
      { url: 'file:///etc/passwd' },
      ctx,
    )
    expect(result.error).toMatch(/unsupported URL scheme/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects a body on GET rather than letting fetch throw', async () => {
    const fetchFn = jsonFetch({})
    const result = await httpRequestTool({ lookupFn: null, fetchFn: fetchFn as unknown as typeof fetch }).execute(
      { url: 'https://x.test/', method: 'GET', body: '{}' },
      ctx,
    )
    expect(result.error).toMatch(/cannot carry a body/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects an unknown method', async () => {
    const result = await httpRequestTool({ lookupFn: null }).execute({ url: 'https://x.test/', method: 'TRACE' }, ctx)
    expect(result.error).toMatch(/unsupported method "TRACE"/)
  })

  it('substitutes a secret placeholder into the request and keeps it out of the result', async () => {
    const fetchFn = vi.fn(
      async () => new Response('echo sk-live-1', { headers: { 'content-type': 'text/plain' } }),
    ) as unknown as typeof fetch
    const tool = httpRequestTool({ lookupFn: null, fetchFn, secrets: { STRIPE_KEY: 'sk-live-1' } })

    const result = await tool.execute(
      { url: 'https://x.test/', headers: { authorization: 'Bearer {{STRIPE_KEY}}' } },
      ctx,
    )

    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers).toEqual({
      authorization: 'Bearer sk-live-1',
    })
    expect(result.content).not.toContain('sk-live-1')
    expect(result.content).toContain('{{STRIPE_KEY}}')
  })

  it('names the available placeholders in its description but never the values', () => {
    const tool = httpRequestTool({
      lookupFn: null,
      secrets: { STRIPE_KEY: 'sk-live-1' },
      allowedHosts: ['api.stripe.com'],
    })
    expect(tool.description).toContain('{{STRIPE_KEY}}')
    expect(tool.description).toContain('api.stripe.com')
    expect(tool.description).not.toContain('sk-live-1')
  })

  it('fails on an unknown placeholder instead of sending a blank credential', async () => {
    const fetchFn = jsonFetch({})
    const result = await httpRequestTool({
      lookupFn: null,
      fetchFn: fetchFn as unknown as typeof fetch,
      secrets: { TOKEN: 'sk-1' },
    }).execute({ url: 'https://x.test/', headers: { authorization: '{{MISSING}}' } }, ctx)
    expect(result.error).toMatch(/unknown secret "MISSING"/)
    expect(result.error).not.toContain('sk-1')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('truncates a response larger than the configured ceiling', async () => {
    const fetchFn = vi.fn(
      async () => new Response('x'.repeat(500), { headers: { 'content-type': 'text/plain' } }),
    ) as unknown as typeof fetch
    const result = await httpRequestTool({ lookupFn: null, fetchFn, maxResponseBytes: 50 }).execute(
      { url: 'https://x.test/' },
      ctx,
    )
    expect(result.content).toContain('[truncated at 50 bytes]')
    expect(result.content.length).toBeLessThan(300)
  })

  it('aborts and reports when the request outruns the timeout', async () => {
    const fetchFn = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }) as unknown as typeof fetch
    const result = await httpRequestTool({ lookupFn: null, fetchFn, timeoutMs: 5 }).execute(
      { url: 'https://x.test/' },
      ctx,
    )
    expect(result).toMatchObject({ ok: false, error: 'request timed out after 5ms' })
  })

  it('passes the caller cancellation through to fetch', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn((_url: string, init: RequestInit) => {
      setTimeout(() => controller.abort(), 0)
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('cancelled by user')))
      })
    }) as unknown as typeof fetch
    const result = await httpRequestTool({ lookupFn: null, fetchFn }).execute(
      { url: 'https://x.test/' },
      { taskId: 't1', signal: controller.signal },
    )
    expect(result).toMatchObject({ ok: false, error: 'cancelled by user' })
  })

  it('only runs once approved, like any other ask-level tool', async () => {
    const registry = new ToolRegistry()
    registry.register(httpRequestTool({ lookupFn: null, fetchFn: jsonFetch({ ok: true }) as unknown as typeof fetch }))
    const call = { id: 'c1', name: 'http_request', args: { url: 'https://x.test/' } }

    expect((await registry.execute(call, ctx)).ok).toBe(false)
    registry.onApproval(() => true)
    expect((await registry.execute({ ...call, id: 'c2' }, ctx)).ok).toBe(true)
  })
})

describe('http_request network restrictions', () => {
  const ctx = { taskId: 't1', signal: new AbortController().signal }
  const ok = async () => new Response('body', { status: 200 })

  it('refuses the cloud metadata endpoint, which no allowlist had to be set to stop', async () => {
    let called = false
    const tool = httpRequestTool({
      fetchFn: async () => {
        called = true
        return ok()
      },
      lookupFn: null,
    })

    const result = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/loopback, private or link-local/)
    expect(called).toBe(false)
  })

  it('refuses a public name that resolves to a private address', async () => {
    const tool = httpRequestTool({
      fetchFn: async () => ok(),
      lookupFn: async () => ['169.254.169.254'],
    })
    const result = await tool.execute({ url: 'https://metadata.evil.test/' }, ctx)
    expect(result.error).toMatch(/resolves to 169\.254\.169\.254/)
  })

  it('reaches a local address once the operator allows it', async () => {
    const tool = httpRequestTool({ fetchFn: async () => ok(), lookupFn: null, network: { allowLocal: true } })
    const result = await tool.execute({ url: 'http://localhost:3000/api' }, ctx)
    expect(result.ok).toBe(true)
  })

  it('vets each redirect hop instead of following it blindly', async () => {
    // The check on the first URL is worth nothing if a 302 can then point
    // anywhere it likes.
    const seen: string[] = []
    const tool = httpRequestTool({
      lookupFn: null,
      fetchFn: async (input) => {
        const url = String(input)
        seen.push(url)
        if (url === 'https://harmless.test/')
          return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
        return ok()
      },
    })

    const result = await tool.execute({ url: 'https://harmless.test/' }, ctx)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/loopback, private or link-local/)
    expect(seen).toEqual(['https://harmless.test/'])
  })

  it('follows an ordinary redirect to a permitted host', async () => {
    const tool = httpRequestTool({
      lookupFn: null,
      fetchFn: async (input) =>
        String(input) === 'https://a.test/'
          ? new Response(null, { status: 301, headers: { location: 'https://b.test/moved' } })
          : new Response('arrived', { status: 200 }),
    })

    const result = await tool.execute({ url: 'https://a.test/' }, ctx)

    expect(result.ok).toBe(true)
    expect(result.content).toContain('arrived')
  })

  it('resolves a relative redirect against the URL it came from', async () => {
    const tool = httpRequestTool({
      lookupFn: null,
      fetchFn: async (input) =>
        String(input) === 'https://a.test/one'
          ? new Response(null, { status: 302, headers: { location: '/two' } })
          : new Response(String(input), { status: 200 }),
    })

    const result = await tool.execute({ url: 'https://a.test/one' }, ctx)

    expect(result.content).toContain('https://a.test/two')
  })

  it('gives up on a redirect loop rather than following it forever', async () => {
    const tool = httpRequestTool({
      lookupFn: null,
      maxRedirects: 3,
      fetchFn: async () => new Response(null, { status: 302, headers: { location: 'https://loop.test/' } }),
    })

    const result = await tool.execute({ url: 'https://loop.test/' }, ctx)

    expect(result.error).toMatch(/too many redirects/)
  })

  it('still honours an explicit allowlist on a redirect target', async () => {
    const tool = httpRequestTool({
      lookupFn: null,
      allowedHosts: ['a.test'],
      fetchFn: async (input) =>
        String(input) === 'https://a.test/'
          ? new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } })
          : ok(),
    })

    const result = await tool.execute({ url: 'https://a.test/' }, ctx)

    expect(result.error).toMatch(/not in the allowed host list/)
  })
})
