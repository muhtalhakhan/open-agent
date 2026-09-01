import type { ForgetRequest, MemoryEntry, MemoryProfile, MemoryProvider, MemorySearchResult, RecallQuery } from './types.js'

/**
 * The narrow slice of the `supermemory` SDK's client this provider actually
 * calls, matching the real `Supermemory` class from `node_modules/supermemory`.
 * Kept as our own interface (rather than importing the SDK's types directly)
 * so tests can inject a fake client without hitting the network or requiring
 * an API key, and so a self-hosted `Supermemory.local()` client — which has
 * the identical shape — works without any code change.
 */
export interface SupermemoryClientLike {
  add(params: { content: string; containerTag?: string; metadata?: Record<string, unknown> }): Promise<{ id: string; status: string }>
  profile(params: { containerTag: string; q?: string }): Promise<{
    profile: { static: string[]; dynamic: string[] }
  }>
  search(params: {
    q: string
    containerTag?: string
    searchMode?: 'hybrid' | 'memories' | 'documents'
    limit?: number
  }): Promise<{
    results: Array<{
      id: string
      memory?: string
      chunk?: string
      similarity: number
      metadata: Record<string, unknown> | null
    }>
  }>
  memories: {
    forget(params: { containerTag: string; id?: string; content?: string; reason?: string }): Promise<{ id: string; forgotten: boolean }>
  }
}

/**
 * Memory provider backed by Supermemory (https://github.com/supermemoryai/supermemory).
 * Works identically against the hosted API or a self-hosted `supermemory-server`
 * instance — only the client's `baseURL` differs, which is Supermemory's own
 * concern, not this adapter's.
 */
export class SupermemoryProvider implements MemoryProvider {
  readonly name = 'supermemory'

  constructor(private readonly client: SupermemoryClientLike) {}

  async remember(entry: MemoryEntry): Promise<{ id: string }> {
    const { id } = await this.client.add({
      content: entry.content,
      containerTag: entry.containerTag,
      metadata: entry.metadata,
    })
    return { id }
  }

  async recall(query: RecallQuery): Promise<MemorySearchResult[]> {
    const { results } = await this.client.search({
      q: query.q,
      containerTag: query.containerTag,
      searchMode: query.mode ?? 'hybrid',
      limit: query.limit,
    })
    return results.map((result): MemorySearchResult => ({
      id: result.id,
      content: result.memory ?? result.chunk ?? '',
      score: result.similarity,
      metadata: result.metadata,
    }))
  }

  async profile(containerTag: string, q?: string): Promise<MemoryProfile> {
    const { profile } = await this.client.profile({ containerTag, q })
    return { static: profile.static, dynamic: profile.dynamic }
  }

  async forget(request: ForgetRequest): Promise<{ forgotten: boolean }> {
    const { forgotten } = await this.client.memories.forget({
      containerTag: request.containerTag,
      id: request.id,
      content: request.content,
      reason: request.reason,
    })
    return { forgotten }
  }
}
