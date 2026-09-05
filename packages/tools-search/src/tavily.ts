import { ProviderHttpError } from '@open-agent/providers'
import type { SearchProvider, SearchQuery, SearchResult } from './types.js'

const DEFAULT_ENDPOINT = 'https://api.tavily.com/search'

export interface TavilySearchOptions {
  apiKey: string
  /** Defaults to Tavily's public endpoint. */
  endpoint?: string
  /** `basic` (default) is one hop; `advanced` costs more and digs deeper. */
  searchDepth?: 'basic' | 'advanced'
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch
}

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>
}

/**
 * [Tavily](https://tavily.com) — a search API aimed at agents, so results
 * arrive already summarised in `content`. The key goes in the Authorization
 * header rather than the body, which keeps it out of anything that logs the
 * request payload.
 */
export class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily'

  constructor(private readonly options: TavilySearchOptions) {}

  async search({ query, maxResults }: SearchQuery, signal: AbortSignal): Promise<SearchResult[]> {
    const fetchFn = this.options.fetchFn ?? fetch
    const endpoint = this.options.endpoint ?? DEFAULT_ENDPOINT

    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_depth: this.options.searchDepth ?? 'basic',
      }),
      signal,
    })
    if (!response.ok) {
      throw new ProviderHttpError(response.status, this.name, endpoint, await response.text())
    }

    const data = (await response.json()) as TavilyResponse
    return (data.results ?? []).slice(0, maxResults).map((result) => ({
      title: result.title ?? '',
      url: result.url ?? '',
      snippet: result.content ?? '',
    }))
  }
}
