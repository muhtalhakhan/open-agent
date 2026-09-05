import { describe, expect, it, vi } from 'vitest'
import { ProviderHttpError } from '@open-agent/providers'
import { BraveSearchProvider, stripHtml } from './brave.js'

const signal = new AbortController().signal

function fakeFetch(body: unknown, init: ResponseInit = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: init.status ?? 200 }))
}

describe('stripHtml', () => {
  it('drops the markup Brave wraps matched terms in', () => {
    expect(stripHtml('a <strong>fast</strong> browser')).toBe('a fast browser')
  })

  it('unescapes the entities that survive it', () => {
    expect(stripHtml('Tom &amp; Jerry &quot;quoted&quot;')).toBe('Tom & Jerry "quoted"')
  })
})

describe('BraveSearchProvider', () => {
  it('sends the query and count, with the key in the subscription header', async () => {
    const fetchFn = fakeFetch({ web: { results: [] } })
    const provider = new BraveSearchProvider({ apiKey: 'brave-key', fetchFn: fetchFn as unknown as typeof fetch })

    await provider.search({ query: 'ada lovelace', maxResults: 3 }, signal)

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.search.brave.com/res/v1/web/search?q=ada%20lovelace&count=3',
      expect.objectContaining({
        headers: { Accept: 'application/json', 'X-Subscription-Token': 'brave-key' },
        signal,
      }),
    )
  })

  it('maps the web results into title/url/snippet, with the markup stripped', async () => {
    const fetchFn = fakeFetch({
      web: {
        results: [
          {
            title: 'Ada <strong>Lovelace</strong>',
            url: 'https://example.com/ada',
            description: 'A <em>programmer</em>.',
          },
        ],
      },
    })
    const provider = new BraveSearchProvider({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch })

    expect(await provider.search({ query: 'ada', maxResults: 5 }, signal)).toEqual([
      { title: 'Ada Lovelace', url: 'https://example.com/ada', snippet: 'A programmer.' },
    ])
  })

  it('returns nothing when the payload has no web results at all', async () => {
    const fetchFn = fakeFetch({})
    const provider = new BraveSearchProvider({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch })
    expect(await provider.search({ query: 'x', maxResults: 5 }, signal)).toEqual([])
  })

  it('never returns more than asked for, whatever the API sends', async () => {
    const fetchFn = fakeFetch({
      web: { results: [1, 2, 3, 4].map((n) => ({ title: `t${n}`, url: `https://x.test/${n}`, description: '' })) },
    })
    const provider = new BraveSearchProvider({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch })
    expect(await provider.search({ query: 'x', maxResults: 2 }, signal)).toHaveLength(2)
  })

  it('throws a ProviderHttpError carrying the status on a non-OK response', async () => {
    const fetchFn = vi.fn(async () => new Response('rate limited', { status: 429 }))
    const provider = new BraveSearchProvider({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch })

    await expect(provider.search({ query: 'x', maxResults: 5 }, signal)).rejects.toMatchObject({
      name: 'ProviderHttpError',
      status: 429,
      provider: 'brave',
    })
    await expect(provider.search({ query: 'x', maxResults: 5 }, signal)).rejects.toBeInstanceOf(ProviderHttpError)
  })

  it('honours a custom endpoint', async () => {
    const fetchFn = fakeFetch({ web: { results: [] } })
    const provider = new BraveSearchProvider({
      apiKey: 'k',
      endpoint: 'https://proxy.test/search',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    await provider.search({ query: 'x', maxResults: 1 }, signal)
    expect((fetchFn.mock.calls[0] as unknown[])[0]).toBe('https://proxy.test/search?q=x&count=1')
  })
})
