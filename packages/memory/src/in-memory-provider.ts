import { randomUUID } from 'node:crypto'
import type {
  ForgetRequest,
  MemoryEntry,
  MemoryProfile,
  MemoryProvider,
  MemorySearchResult,
  RecallQuery,
} from './types.js'

interface StoredMemory extends MemoryEntry {
  id: string
  forgotten: boolean
}

function overlapScore(query: string, content: string): number {
  const queryWords = new Set(query.toLowerCase().split(/\W+/).filter(Boolean))
  const contentWords = new Set(content.toLowerCase().split(/\W+/).filter(Boolean))
  if (queryWords.size === 0 || contentWords.size === 0) return 0
  let hits = 0
  for (const word of queryWords) if (contentWords.has(word)) hits++
  return hits / queryWords.size
}

/**
 * A dependency-free, in-process MemoryProvider with the same interface as
 * SupermemoryProvider. Useful as the default before a user configures a real
 * backend, and in tests that shouldn't need network access or an API key.
 * Keyword-overlap "search" and a naive profile — no real semantic ranking.
 */
export class InMemoryMemoryProvider implements MemoryProvider {
  readonly name = 'in-memory'
  private readonly entries: StoredMemory[] = []

  async remember(entry: MemoryEntry): Promise<{ id: string }> {
    const id = randomUUID()
    this.entries.push({ ...entry, id, forgotten: false })
    return { id }
  }

  async recall(query: RecallQuery): Promise<MemorySearchResult[]> {
    return this.entries
      .filter((e) => e.containerTag === query.containerTag && !e.forgotten)
      .map((e) => ({ id: e.id, content: e.content, score: overlapScore(query.q, e.content), metadata: e.metadata }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit ?? 10)
  }

  async profile(containerTag: string): Promise<MemoryProfile> {
    const live = this.entries.filter((e) => e.containerTag === containerTag && !e.forgotten)
    const half = Math.ceil(live.length / 2)
    return {
      static: live.slice(0, half).map((e) => e.content),
      dynamic: live.slice(half).map((e) => e.content),
    }
  }

  async forget(request: ForgetRequest): Promise<{ forgotten: boolean }> {
    const entry = this.entries.find(
      (e) =>
        e.containerTag === request.containerTag &&
        !e.forgotten &&
        (request.id ? e.id === request.id : request.content ? e.content === request.content : false),
    )
    if (!entry) return { forgotten: false }
    entry.forgotten = true
    return { forgotten: true }
  }
}
