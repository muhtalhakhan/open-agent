import { describe, expect, it, vi } from 'vitest'
import { fetchUrlTool } from './fetch-url.js'
import { htmlToText } from './html-text.js'

const ctx = { taskId: 't', signal: new AbortController().signal }

/** A fetch that answers each URL from a table, and records what was asked for. */
function site(pages: Record<string, { status?: number; type?: string; body?: string; location?: string }>) {
  return vi.fn(async (url: string) => {
    const page = pages[url]
    if (!page) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    const headers: Record<string, string> = {}
    if (page.type) headers['content-type'] = page.type
    if (page.location) headers.location = page.location
    return new Response(page.body ?? '', { status: page.status ?? 200, headers })
  })
}

const tool = (fetchFn: ReturnType<typeof site>, extra: Parameters<typeof fetchUrlTool>[0] = {}) =>
  fetchUrlTool({ lookupFn: null, fetchFn: fetchFn as unknown as typeof fetch, ...extra })

describe('htmlToText', () => {
  it('keeps the title, headings, list items and links, and drops scripts, styles and markup', () => {
    const { title, text } = htmlToText(`<!doctype html><html><head><title>Docs &amp; Guides</title>
      <style>body { color: red }</style><script>alert("x")</script></head>
      <body><h1>Install</h1><p>Run <code>npm i</code>&nbsp;now.</p>
      <ul><li>One</li><li>Two</li></ul><p>See <a href="/more">the guide</a>.</p><!-- hidden --></body></html>`)

    expect(title).toBe('Docs & Guides')
    expect(text).toBe('# Install\n\nRun npm i now.\n\n- One\n- Two\n\nSee the guide (/more).')
    expect(text).not.toMatch(/alert|color|hidden/)
  })

  it('decodes numeric entities', () => {
    expect(htmlToText('<p>&#169; &#x2014; &bogus;</p>').text).toBe('© — &bogus;')
  })
})

describe('fetchUrlTool', () => {
  it('is safe, and its output is untrusted', () => {
    const t = tool(site({}))
    expect(t.permissionLevel).toBe('safe')
    expect(t.untrustedOutput).toBe(true)
  })

  it('returns a page as readable text with its URL and title', async () => {
    const fetchFn = site({
      'https://example.com/': { type: 'text/html; charset=utf-8', body: '<title>Hi</title><p>Hello there</p>' },
    })

    const result = await tool(fetchFn).execute({ url: 'https://example.com/' }, ctx)

    expect(result).toEqual({ ok: true, content: 'URL: https://example.com/\nTitle: Hi\n\nHello there' })
  })

  it('passes plain text through as it is', async () => {
    const fetchFn = site({ 'https://example.com/a.txt': { type: 'text/plain', body: '  line one\nline two  ' } })

    expect((await tool(fetchFn).execute({ url: 'https://example.com/a.txt' }, ctx)).content).toBe(
      'URL: https://example.com/a.txt\n\nline one\nline two',
    )
  })

  it('reads a long page a part at a time', async () => {
    const fetchFn = site({ 'https://example.com/long': { type: 'text/plain', body: 'abcdefghij' } })
    const t = tool(fetchFn, { maxChars: 4 })

    expect((await t.execute({ url: 'https://example.com/long' }, ctx)).content).toBe(
      'URL: https://example.com/long\n\nabcd\n\n[characters 0-4 of 10. Read on with start=4.]',
    )
    expect((await t.execute({ url: 'https://example.com/long', start: 8 }, ctx)).content).toBe(
      'URL: https://example.com/long\n\nij',
    )
  })

  it('refuses a page that is not text, and reports an HTTP error', async () => {
    const fetchFn = site({
      'https://example.com/v.mp4': { type: 'video/mp4', body: 'xx' },
      'https://example.com/gone': { status: 410, type: 'text/html', body: 'gone' },
    })

    expect(await tool(fetchFn).execute({ url: 'https://example.com/v.mp4' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is video\/mp4, not a web page/),
    })
    expect(await tool(fetchFn).execute({ url: 'https://example.com/gone' }, ctx)).toMatchObject({
      ok: false,
      error: 'HTTP 410 from https://example.com/gone',
    })
  })

  it('refuses local addresses, before and after a redirect', async () => {
    const fetchFn = site({
      'https://example.com/hop': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
    })

    expect(await tool(fetchFn).execute({ url: 'http://127.0.0.1:8080/' }, ctx)).toMatchObject({ ok: false })
    const redirected = await tool(fetchFn).execute({ url: 'https://example.com/hop' }, ctx)

    expect(redirected.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalledWith('http://169.254.169.254/latest/meta-data/', expect.anything())
  })

  it('refuses a public name that resolves to a private address', async () => {
    const fetchFn = site({ 'https://internal.example/': { type: 'text/plain', body: 'secret' } })
    const t = fetchUrlTool({ fetchFn: fetchFn as unknown as typeof fetch, lookupFn: async () => ['10.0.0.5'] })

    expect(await t.execute({ url: 'https://internal.example/' }, ctx)).toMatchObject({ ok: false })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
