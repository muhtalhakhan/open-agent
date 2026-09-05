/**
 * The search-engine seam. Same shape of decision as `LlmAdapter`: one small
 * interface, one adapter per vendor, and nothing above it knows which engine
 * answered. `webSearchTool` takes a `SearchProvider` and never names one.
 */
export interface SearchResult {
  title: string
  url: string
  /** The engine's own summary of the page. May be empty. */
  snippet: string
}

export interface SearchQuery {
  query: string
  /** Upper bound on results; the provider may return fewer. */
  maxResults: number
}

export interface SearchProvider {
  /** Adapter name, e.g. `brave` — used in errors and the tool description. */
  name: string
  search(query: SearchQuery, signal: AbortSignal): Promise<SearchResult[]>
}
