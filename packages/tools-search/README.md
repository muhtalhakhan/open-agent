# @open-agent/tools-search

One tool, `web_search`: a query in, a ranked list of results (title, URL, snippet) out, straight from a search API.

## Why it isn't the browser tools

`tools-browser` can navigate to a known URL and read the DOM, so searching _could_ be done by driving a browser to a search engine and scraping its results page. That costs a full browser round-trip for what is one HTTP call, breaks whenever the engine changes its markup, and forces a browser (and Python, and browser-use) into agent configurations that would otherwise need none. This package stands alone.

The two complement each other: search here, then hand a URL to the browser when a page actually has to be interacted with.

## Usage

```ts
import { ToolRegistry } from '@open-agent/agent'
import { BraveSearchProvider, webSearchTool } from '@open-agent/tools-search'

const tools = new ToolRegistry()
tools.register(webSearchTool(new BraveSearchProvider({ apiKey: process.env.BRAVE_SEARCH_API_KEY! })))
```

In the CLI, set `BRAVE_SEARCH_API_KEY` or `TAVILY_API_KEY` — see `.env.example`. With neither set the tool is not registered.

## Providers

`SearchProvider` is `name` + `search(query, signal)`, the same seam `LlmAdapter` is for models: the tool never names an engine, and a new one is an adapter rather than a change to the tool.

- **`BraveSearchProvider`** — [Brave Search API](https://brave.com/search/api/). Key in `X-Subscription-Token`; result descriptions arrive with `<strong>` markup around matched terms, which is stripped before the model sees them.
- **`TavilySearchProvider`** — [Tavily](https://tavily.com), built for agents, so snippets come back already summarised. Key in the `Authorization` header rather than the body, so it stays out of anything that logs request payloads. `searchDepth: 'advanced'` digs deeper at a higher cost.

Both throw `ProviderHttpError` (from `@open-agent/providers`) on a non-OK response, so the status is a field rather than prose; the tool turns that into a normal `ToolResult` error instead of letting it escape.

## Permission level

`safe`. A search reads, it doesn't act — the same reasoning that makes browser navigation `safe` in `docs/security-model.md`. What comes back is untrusted web content like any other, and is the model's to weigh, not to obey.

## Context budget

A results page is easy to turn into a context dump, so two ceilings apply: at most `resultLimit` results (default 10, whatever the model asks for) and snippets cut at `maxSnippetChars` (default 300). The default request size is 5.
