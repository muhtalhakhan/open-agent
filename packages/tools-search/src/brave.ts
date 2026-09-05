import { ProviderHttpError } from '@open-agent/providers'
import type { SearchProvider, SearchQuery, SearchResult } from './types.js'

const DEFAULT_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

export interface BraveSearchOptions {
  apiKey: string
  /** Defaults to Brave's public endpoint. */
  endpoint?: string
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch
}

interface BraveResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
}

/**
 * Brave's own markup: descriptions come back with `<strong>` around the
 * matched terms, and entities unescaped. The model gets prose, not HTML.
 */
const TAGS = /<[^>]*>/g
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}

export function stripHtml(text: string): string {
  return text
    .replace(TAGS, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim()
}

/** [Brave Search API](https://brave.com/search/api/) — key in `X-Subscription-Token`. */
export class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave'

  constructor(private readonly options: BraveSearchOptions) {}

  async search({ query, maxResults }: SearchQuery, signal: AbortSignal): Promise<SearchResult[]> {
    const fetchFn = this.options.fetchFn ?? fetch
    const endpoint = this.options.endpoint ?? DEFAULT_ENDPOINT
    const url = `${endpoint}?q=${encodeURIComponent(query)}&count=${maxResults}`

    const response = await fetchFn(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': this.options.apiKey,
      },
      signal,
    })
    if (!response.ok) {
      throw new ProviderHttpError(response.status, this.name, url, await response.text())
    }

    const data = (await response.json()) as BraveResponse
    return (data.web?.results ?? []).slice(0, maxResults).map((result) => ({
      title: stripHtml(result.title ?? ''),
      url: result.url ?? '',
      snippet: stripHtml(result.description ?? ''),
    }))
  }
}
