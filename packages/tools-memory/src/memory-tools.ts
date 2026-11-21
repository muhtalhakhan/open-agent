import type { ToolDefinition, ToolExecutionContext, ToolRegistry, ToolResult } from '@open-agent/agent'
import type { MemoryProvider } from '@open-agent/memory'

export const REMEMBER_TOOL = 'remember'
export const RECALL_TOOL = 'recall'
export const FORGET_TOOL = 'forget'
export const LIST_MEMORIES_TOOL = 'list_memories'

const REMEMBER_SCHEMA = {
  type: 'object',
  properties: {
    content: {
      type: 'string',
      description: 'The fact, preference, or snippet to remember.',
    },
    metadata: {
      type: 'object',
      description: 'Optional metadata to associate with this memory (e.g. type: user | project | reference).',
    },
  },
  required: ['content'],
}

const RECALL_SCHEMA = {
  type: 'object',
  properties: {
    q: {
      type: 'string',
      description: 'Search query or keywords to recall from memory.',
    },
    limit: {
      type: 'integer',
      description: 'Maximum number of results to return (default 5, max 50).',
    },
  },
  required: ['q'],
}

const FORGET_SCHEMA = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'The ID of the memory to forget (from recall or list_memories).',
    },
    content: {
      type: 'string',
      description: 'Exact content match of the memory to forget, if ID is not known.',
    },
    reason: {
      type: 'string',
      description: 'Optional reason for forgetting.',
    },
  },
}

const LIST_MEMORIES_SCHEMA = {
  type: 'object',
  properties: {
    limit: {
      type: 'integer',
      description: 'Maximum number of memories to list (default 20, max 200).',
    },
  },
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

/**
 * Creates the `remember` tool: agent saves a durable fact or preference to long-term memory.
 */
export function rememberTool(provider: MemoryProvider, containerTag: string): ToolDefinition<Record<string, unknown>> {
  return {
    name: REMEMBER_TOOL,
    description:
      'Save a durable fact, preference, or snippet to long-term memory. ' +
      'Use this when you learn something important about the user, project, or task that should be remembered across future sessions.',
    schema: REMEMBER_SCHEMA,
    permissionLevel: 'safe',
    async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
      const content = String(args.content ?? '').trim()
      if (!content) return fail('content is required')
      if (content.length > 20000) return fail('content is too long (max 20,000 characters)')

      const metadata =
        typeof args.metadata === 'object' && args.metadata !== null && !Array.isArray(args.metadata)
          ? (args.metadata as Record<string, unknown>)
          : undefined

      try {
        const { id } = await provider.remember({
          content,
          containerTag,
          ...(metadata ? { metadata } : {}),
        })
        return {
          ok: true,
          content: `Remembered fact in container "${containerTag}" (id: ${id}).`,
        }
      } catch (err) {
        return fail(`Failed to remember fact: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

/**
 * Creates the `recall` tool: search memory mid-task for relevant facts or past context.
 */
export function recallTool(provider: MemoryProvider, containerTag: string): ToolDefinition<Record<string, unknown>> {
  return {
    name: RECALL_TOOL,
    description:
      'Search long-term memory for relevant facts, preferences, or past context by similarity or keywords. ' +
      'Use this when you need background information or past details mid-task.',
    schema: RECALL_SCHEMA,
    permissionLevel: 'safe',
    async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
      const q = String(args.q ?? '').trim()
      if (!q) return fail('query q is required')

      const rawLimit = typeof args.limit === 'number' ? args.limit : Number(args.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 50) : 5

      try {
        const results = await provider.recall({ q, containerTag, limit })
        if (results.length === 0) {
          return { ok: true, content: `No matching memories found for "${q}".` }
        }

        const lines = [`Found ${results.length} memory(ies) for "${q}":\n`]
        for (const r of results) {
          lines.push(`- [id: ${r.id}] (score: ${r.score.toFixed(2)}) ${r.content}`)
        }
        return { ok: true, content: lines.join('\n') }
      } catch (err) {
        return fail(`Failed to recall memories: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

/**
 * Creates the `forget` tool: forgets a memory on request by ID or content match.
 */
export function forgetTool(provider: MemoryProvider, containerTag: string): ToolDefinition<Record<string, unknown>> {
  return {
    name: FORGET_TOOL,
    description:
      'Forget a memory on request by its ID or exact content match, with an optional reason. ' +
      'Use this when information is outdated, incorrect, or the user asked to forget something.',
    schema: FORGET_SCHEMA,
    permissionLevel: 'safe',
    async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
      const id = args.id ? String(args.id).trim() : undefined
      const content = args.content ? String(args.content).trim() : undefined
      const reason = args.reason ? String(args.reason).trim() : undefined

      if (!id && !content) {
        return fail('provide either memory id or content to forget')
      }

      try {
        const { forgotten } = await provider.forget({
          containerTag,
          ...(id ? { id } : {}),
          ...(content ? { content } : {}),
          ...(reason ? { reason } : {}),
        })

        if (!forgotten) {
          return fail('No matching memory found to forget, or it was already forgotten.')
        }

        return {
          ok: true,
          content: `Memory successfully forgotten (${id ? `id: ${id}` : `content: "${content}"`}).`,
        }
      } catch (err) {
        return fail(`Failed to forget memory: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

/**
 * Creates the `list_memories` tool: list stored memories in the active container.
 */
export function listMemoriesTool(
  provider: MemoryProvider,
  containerTag: string,
): ToolDefinition<Record<string, unknown>> {
  return {
    name: LIST_MEMORIES_TOOL,
    description:
      'List recent memories in the container to inspect what is stored. ' +
      'Useful for reviewing stored facts or finding a memory ID to forget.',
    schema: LIST_MEMORIES_SCHEMA,
    permissionLevel: 'safe',
    async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
      const rawLimit = typeof args.limit === 'number' ? args.limit : Number(args.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 20

      if (!provider.list) {
        return {
          ok: true,
          content: `The memory provider (${provider.name}) does not support listing all memories directly. Use recall to search memories instead.`,
        }
      }

      try {
        const items = await provider.list(containerTag, { limit })
        if (items.length === 0) {
          return { ok: true, content: 'No memories stored in container yet.' }
        }

        const lines = [`Stored memories in container "${containerTag}" (${items.length}):\n`]
        for (const item of items) {
          lines.push(`- [id: ${item.id}] ${item.content}`)
        }
        return { ok: true, content: lines.join('\n') }
      } catch (err) {
        return fail(`Failed to list memories: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

/**
 * Registers the memory tools (`remember`, `recall`, `forget`, `list_memories`) with the registry,
 * scoped to the specified provider and container tag.
 */
export function mountMemoryTools(registry: ToolRegistry, provider: MemoryProvider, containerTag: string): () => void {
  const disposers = [
    registry.register(rememberTool(provider, containerTag)),
    registry.register(recallTool(provider, containerTag)),
    registry.register(forgetTool(provider, containerTag)),
    registry.register(listMemoriesTool(provider, containerTag)),
  ]
  return () => disposers.forEach((dispose) => dispose())
}
