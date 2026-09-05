import { describe, expect, it, vi } from 'vitest'
import { TavilySearchProvider } from './tavily.js'

const signal = new AbortController().signal

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('TavilySearchProvider', () => {
  it('posts the query with the key in the Authorization header, not the body', async () => {
    const fetchFn = fakeFetch({ results: [] })
    const provider = new TavilySearchProvider({ apiKey: 'tvly-1', fetchFn: fetchFn as unknown as typeof fetch })

    await provider.search({ query: 'ada lovelace', maxResults: 4 }, signal)

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.tavily.com/search')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tvly-1')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'ada lovelace',
      max_results: 4,
      search_depth: 'basic',
    })
    expect(init.body as string).not.toContain('tvly-1')
  })

  it('passes through the configured search depth', async () => {
    const fetchFn = fakeFetch({ results: [] })
    const provider = new TavilySearchProvider({
      apiKey: 'k',
      searchDepth: 'advanced',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    await provider.search({ query: 'x', maxResults: 1 }, signal)
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).search_depth).toBe('advanced')
  })

  it('maps results, taking the summarised content as the snippet', async () => {
    const fetchFn = fakeFetch({
      results: [{ title: 'Ada', url: 'https://example.com/ada', content: 'The first programmer.' }],
    })
    const provider = new TavilySearchProvider({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch })

    expect(await provider.search({ query: 'ada', maxResults: 5 }, signal)).toEqual([
      { title: 'Ada', url: 'https://example.com/ada', snippet: 'The first programmer.' },
    ])
  })

  it('throws a ProviderHttpError on a non-OK response', async () => {
    const fetchFn = fakeFetch({ detail: 'bad key' }, 401)
    const provider = new TavilySearchProvider({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch })
    await expect(provider.search({ query: 'x', maxResults: 5 }, signal)).rejects.toMatchObject({
      name: 'ProviderHttpError',
      status: 401,
      provider: 'tavily',
    })
  })
})
