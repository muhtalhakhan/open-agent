export type SearchMode = 'hybrid' | 'memories' | 'documents'

export interface MemoryEntry {
  content: string
  /** Scopes memories to a user/task/project — Supermemory calls this a "container tag". */
  containerTag: string
  metadata?: Record<string, unknown>
}

export interface MemorySearchResult {
  id: string
  content: string
  score: number
  metadata?: Record<string, unknown> | null
}

export interface MemoryProfile {
  /** Durable facts/preferences that remain relevant long-term. */
  static: string[]
  /** Recent activity/context. */
  dynamic: string[]
}

export interface RecallQuery {
  q: string
  containerTag: string
  mode?: SearchMode
  limit?: number
}

export interface ForgetRequest {
  containerTag: string
  id?: string
  /** Exact content match, for when the caller doesn't have an id. */
  content?: string
  reason?: string
}

/**
 * A provider-agnostic seam for the memory subsystem (see docs/agent-design.md
 * "Memory model"). `SupermemoryProvider` is the reference implementation;
 * any other memory backend implements the same interface so the agent
 * runtime never depends on a specific vendor.
 */
export interface MemoryProvider {
  readonly name: string
  /** Store a fact/conversation snippet. Long-term memory + semantic search. */
  remember(entry: MemoryEntry): Promise<{ id: string }>
  /** Search memories (and optionally documents) by similarity. */
  recall(query: RecallQuery): Promise<MemorySearchResult[]>
  /** Auto-maintained user profile: stable facts + recent activity. User preferences. */
  profile(containerTag: string, q?: string): Promise<MemoryProfile>
  /** Soft-delete a memory. Memory deletion / privacy controls. */
  forget(request: ForgetRequest): Promise<{ forgotten: boolean }>
}
