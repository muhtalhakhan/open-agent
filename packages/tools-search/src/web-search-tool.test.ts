import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '@open-agent/agent'
import { webSearchTool } from './web-search-tool.js'
import type { SearchProvider, SearchResult } from './types.js'

const ctx = { taskId: 't1', signal: new AbortController().signal }

function fakeProvider(results: SearchResult[]): SearchProvider & { search: ReturnType<typeof vi.fn> } {
  return { name: 'fake', search: vi.fn(async () => results) }
}

const oneResult: SearchResult[] = [{ title: 'Ada Lovelace', url: 'https://example.com/ada', snippet: 'A programmer.' }]

describe('webSearchTool', () => {
  it('runs without approval — a search reads, it does not act', () => {
    expect(webSearchTool(fakeProvider([])).permissionLevel).toBe('safe')
  })

  it('formats results as a numbered title/url/snippet list', async () => {
    const result = await webSearchTool(fakeProvider(oneResult)).execute({ query: 'ada lovelace' }, ctx)
    expect(result).toEqual({
      ok: true,
      content: '1. Ada Lovelace\n   https://example.com/ada\n   A programmer.',
    })
  })

  it('falls back to the URL when a result has no title, and omits an empty snippet', async () => {
    const result = await webSearchTool(fakeProvider([{ title: '', url: 'https://x.test/a', snippet: '' }])).execute(
      { query: 'x' },
      ctx,
    )
    expect(result.content).toBe('1. https://x.test/a\n   https://x.test/a')
  })

  it('says so plainly when the engine found nothing', async () => {
    const result = await webSearchTool(fakeProvider([])).execute({ query: 'asdfqwer' }, ctx)
    expect(result).toEqual({ ok: true, content: 'No results for "asdfqwer".' })
  })

  it('asks the provider for the default number of results', async () => {
    const provider = fakeProvider(oneResult)
    await webSearchTool(provider).execute({ query: 'ada' }, ctx)
    expect(provider.search).toHaveBeenCalledWith({ query: 'ada', maxResults: 5 }, ctx.signal)
  })

  it('clamps a request for more results than the limit allows', async () => {
    const provider = fakeProvider(oneResult)
    await webSearchTool(provider, { resultLimit: 3 }).execute({ query: 'ada', maxResults: 500 }, ctx)
    expect(provider.search).toHaveBeenCalledWith({ query: 'ada', maxResults: 3 }, ctx.signal)
  })

  it('clamps a nonsensical result count up to one', async () => {
    const provider = fakeProvider(oneResult)
    await webSearchTool(provider).execute({ query: 'ada', maxResults: 0 }, ctx)
    expect(provider.search).toHaveBeenCalledWith({ query: 'ada', maxResults: 1 }, ctx.signal)
  })

  it('truncates a long snippet so one call cannot flood the context', async () => {
    const provider = fakeProvider([{ title: 'T', url: 'https://x.test/', snippet: 'word '.repeat(200) }])
    const result = await webSearchTool(provider, { maxSnippetChars: 20 }).execute({ query: 'x' }, ctx)
    expect(result.content).toContain('word word word word...')
    expect(result.content.length).toBeLessThan(80)
  })

  it('collapses whitespace inside a snippet', async () => {
    const provider = fakeProvider([{ title: 'T', url: 'https://x.test/', snippet: ' a \n\n  b ' }])
    const result = await webSearchTool(provider).execute({ query: 'x' }, ctx)
    expect(result.content.endsWith('   a b')).toBe(true)
  })

  it('rejects an empty query without calling the provider', async () => {
    const provider = fakeProvider(oneResult)
    const result = await webSearchTool(provider).execute({ query: '   ' }, ctx)
    expect(result).toMatchObject({ ok: false, error: 'query is required' })
    expect(provider.search).not.toHaveBeenCalled()
  })

  it('reports a provider failure as a tool error rather than throwing', async () => {
    const provider: SearchProvider = {
      name: 'fake',
      search: async () => {
        throw new Error('brave: 429 rate limited')
      },
    }
    const result = await webSearchTool(provider).execute({ query: 'x' }, ctx)
    expect(result).toEqual({ ok: false, content: '', error: 'brave: 429 rate limited' })
  })

  it('passes the caller cancellation signal to the provider', async () => {
    const controller = new AbortController()
    const provider = fakeProvider(oneResult)
    await webSearchTool(provider).execute({ query: 'x' }, { taskId: 't1', signal: controller.signal })
    expect(provider.search.mock.calls[0][1]).toBe(controller.signal)
  })

  it('needs no approval to run through the registry', async () => {
    const registry = new ToolRegistry()
    registry.register(webSearchTool(fakeProvider(oneResult)))
    const result = await registry.execute({ id: 'c1', name: 'web_search', args: { query: 'ada' } }, ctx)
    expect(result.ok).toBe(true)
  })
})
