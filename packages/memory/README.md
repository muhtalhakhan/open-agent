# @open-agent/memory

Long-term memory and user profiles, via a provider-agnostic `MemoryProvider` seam — matching the "everything is swappable" rule in `docs/architecture.md`.

## Pieces

- **`MemoryProvider`** (`src/types.ts`) — `remember()`, `recall()`, `profile()`, `forget()`. Nothing else in the agent runtime should depend on a specific memory backend's API shape.
- **`SupermemoryProvider`** (`src/supermemory-provider.ts`) — backed by [Supermemory](https://github.com/supermemoryai/supermemory): automatic fact extraction, contradiction/temporal handling, and auto-maintained static/dynamic user profiles, on top of hybrid RAG+memory search. Works unchanged against the hosted API or a self-hosted `supermemory-server` — only the client's `baseURL` differs.
- **`Mem0Provider`** (`src/mem0-provider.ts`) — backed by [mem0](https://github.com/mem0ai/mem0), scoped by `userId`. No built-in static/dynamic profile split of its own — `profile()` returns every memory as `static`. `forget()` requires an id; unlike Supermemory it has no exact-content-match fallback.
- **`InMemoryMemoryProvider`** (`src/in-memory-provider.ts`) — dependency-free, in-process fallback (keyword-overlap search, no real semantic ranking) for tests and offline use before a real backend is configured.
- **`memoryPlugin`** (`src/plugins.ts`) — mounts a provider as `ctx.memory`, same pattern as `ctx.llm`/`ctx.tools` in `@open-agent/agent`.

## Example

```ts
import Supermemory from 'supermemory'
import { SupermemoryProvider, memoryPlugin } from '@open-agent/memory'

const client = new Supermemory({ apiKey: process.env.SUPERMEMORY_API_KEY })
// or, self-hosted: const client = await Supermemory.local()

const memory = new SupermemoryProvider(client)
ctx.plugin(memoryPlugin(memory))

await memory.remember({ content: 'User prefers dark mode', containerTag: 'user_123' })
const { profile } = await ctx.get('memory')!.profile('user_123')
```

`containerTag` is the scoping key — typically a user id, but a task, project, or client id works too, mirroring how an agent profile scopes tools.
