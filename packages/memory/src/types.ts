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

/** One stored memory, as a listing returns it. */
export interface MemoryItem {
  id: string
  content: string
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

/** Update an existing memory entry's content or metadata. */
export interface MemoryUpdate {
  id: string
  containerTag: string
  content?: string
  metadata?: Record<string, unknown>
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
  /** Edit/update an existing memory's content or metadata. */
  update(request: MemoryUpdate): Promise<{ updated: boolean }>
  /**
   * Every live memory in a container, newest first where the backend knows
   * the order. What makes memory inspectable rather than only searchable.
   *
   * Optional: a backend with no listing that returns forgettable ids leaves it
   * out, and a UI falls back to `recall()` — a search can still find any one
   * memory, it just cannot show all of them at once.
   */
  list?(containerTag: string, options?: { limit?: number }): Promise<MemoryItem[]>
}
