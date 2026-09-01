import type { ForgetRequest, MemoryEntry, MemoryProfile, MemoryProvider, MemorySearchResult, RecallQuery } from './types.js'

/**
 * The narrow slice of the `mem0ai` SDK's MemoryClient this provider calls,
 * matching its real generated types. Kept as our own interface (rather than
 * importing the SDK's types directly) so tests can inject a fake client
 * without hitting the network or requiring an API key.
 */
export interface Mem0ClientLike {
  add(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options: { userId: string; metadata?: Record<string, unknown> },
  ): Promise<Array<{ id: string }>>
  search(
    query: string,
    options: { filters: Record<string, unknown>; topK?: number },
  ): Promise<{ results: Array<{ id: string; memory?: string; score?: number; metadata?: unknown }> }>
  getAll(options: { filters: Record<string, unknown> }): Promise<{ results: Array<{ id: string; memory?: string }> }>
  delete(memoryId: string): Promise<{ message: string }>
}

/**
 * Memory provider backed by mem0 (https://github.com/mem0ai/mem0). An
 * alternate to SupermemoryProvider behind the same MemoryProvider seam —
 * pick either without changing anything else in the agent runtime.
 *
 * mem0 scopes `add()` by `userId` directly, but `search()`/`getAll()` only
 * accept a loosely-typed `filters: Record<string, unknown>` in the SDK's
 * generated types — there's no dedicated userId param on those two. This
 * provider filters with `{ user_id: containerTag }`, mem0's documented REST
 * filter key; verify this against a live account if results come back
 * empty, since the SDK doesn't type-check the filter's contents.
 *
 * mem0 also has no built-in static/dynamic profile split the way
 * Supermemory does — `profile()` here returns every memory as `static`
 * with an empty `dynamic`, which is a real limitation of this provider,
 * not a bug.
 */
export class Mem0Provider implements MemoryProvider {
  readonly name = 'mem0'

  constructor(private readonly client: Mem0ClientLike) {}

  async remember(entry: MemoryEntry): Promise<{ id: string }> {
    const [memory] = await this.client.add([{ role: 'user', content: entry.content }], {
      userId: entry.containerTag,
      metadata: entry.metadata,
    })
    return { id: memory.id }
  }

  async recall(query: RecallQuery): Promise<MemorySearchResult[]> {
    const { results } = await this.client.search(query.q, { filters: { user_id: query.containerTag }, topK: query.limit })
    return results.map((result): MemorySearchResult => ({
      id: result.id,
      content: result.memory ?? '',
      score: result.score ?? 0,
      metadata: (result.metadata as Record<string, unknown> | null | undefined) ?? undefined,
    }))
  }

  async profile(containerTag: string): Promise<MemoryProfile> {
    const { results } = await this.client.getAll({ filters: { user_id: containerTag } })
    return { static: results.map((r) => r.memory ?? ''), dynamic: [] }
  }

  async forget(request: ForgetRequest): Promise<{ forgotten: boolean }> {
    // mem0's delete() only accepts a memory id — unlike Supermemory, it has
    // no exact-content-match fallback, so a content-only request can't be honored.
    if (!request.id) return { forgotten: false }
    await this.client.delete(request.id)
    return { forgotten: true }
  }
}
