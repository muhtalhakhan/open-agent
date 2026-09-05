import type { ToolDefinition } from '@open-agent/agent'
import type { SearchProvider } from './types.js'

/** Enough to choose what to open next, without pasting a whole results page into the context. */
const DEFAULT_MAX_RESULTS = 5
const RESULT_LIMIT = 10
const DEFAULT_MAX_SNIPPET_CHARS = 300

export interface WebSearchToolOptions {
  /** Results returned when the model doesn't ask for a specific number (default 5). */
  defaultMaxResults?: number
  /** Ceiling the model cannot exceed, however many it asks for (default 10). */
  resultLimit?: number
  /** Snippets longer than this are cut, with an ellipsis (default 300). */
  maxSnippetChars?: number
}

type WebSearchArgs = {
  query: string
  maxResults?: number
}

function truncate(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars).trimEnd()}...` : collapsed
}

/**
 * `web_search`: a query in, a ranked list of title/url/snippet out, straight
 * from a search API. Distinct from the browser tools on purpose — searching
 * by navigating to a search engine and scraping its results page costs a
 * full browser round-trip and breaks whenever the page's markup changes, and
 * it forces a browser into agent configurations that would otherwise not
 * need one. The two complement each other: search here, then hand a URL to
 * the browser when the page actually has to be interacted with.
 *
 * `safe`, in line with the "browsing itself isn't dangerous" stance in
 * docs/security-model.md: a search reads, it doesn't act. What comes back is
 * untrusted content like any other web text, and is the model's to weigh,
 * not to obey.
 */
export function webSearchTool(
  provider: SearchProvider,
  options: WebSearchToolOptions = {},
): ToolDefinition<WebSearchArgs> {
  const resultLimit = options.resultLimit ?? RESULT_LIMIT
  const defaultMaxResults = Math.min(options.defaultMaxResults ?? DEFAULT_MAX_RESULTS, resultLimit)
  const maxSnippetChars = options.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS

  return {
    name: 'web_search',
    description:
      'Search the web and get back a ranked list of results (title, URL, snippet). Use it to find pages; open one with a browser tool only if you need to interact with it.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: resultLimit,
          description: `How many results to return (default ${defaultMaxResults}, max ${resultLimit}).`,
        },
      },
      required: ['query'],
    },
    permissionLevel: 'safe',
    async execute(args, context) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) return { ok: false, content: '', error: 'query is required' }

      // The model's number is a request, not a promise: clamped here so a
      // stray `maxResults: 500` can't turn one tool call into a context dump.
      const requested = Number(args.maxResults ?? defaultMaxResults)
      const maxResults = Number.isFinite(requested)
        ? Math.min(Math.max(Math.trunc(requested), 1), resultLimit)
        : defaultMaxResults

      try {
        const results = await provider.search({ query, maxResults }, context.signal)
        if (!results.length) return { ok: true, content: `No results for "${query}".` }

        const content = results
          .map((result, index) => {
            const lines = [`${index + 1}. ${result.title || result.url}`, `   ${result.url}`]
            const snippet = truncate(result.snippet, maxSnippetChars)
            if (snippet) lines.push(`   ${snippet}`)
            return lines.join('\n')
          })
          .join('\n\n')
        return { ok: true, content }
      } catch (err) {
        return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
