# examples

Runnable scripts demonstrating the agent runtime end to end, using the real workspace packages' TypeScript source (via `tsx`, no build step needed).

- **`research-and-report.ts`** — the original v0.1 success criterion: open a browser, search for the latest AI news, summarize it, save `report.md`. Needs Python + `browser-use` installed and an OpenAI-compatible API key (OpenAI, OpenRouter, Ollama, LM Studio, ...). See the header comment in the file for exact env vars.

```bash
npx tsx examples/research-and-report.ts
```
