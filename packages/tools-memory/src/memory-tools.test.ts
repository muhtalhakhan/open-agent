import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry, type ToolExecutionContext } from '@open-agent/agent'
import { InMemoryMemoryProvider, type MemoryProvider } from '@open-agent/memory'
import {
  FORGET_TOOL,
  LIST_MEMORIES_TOOL,
  RECALL_TOOL,
  REMEMBER_TOOL,
  forgetTool,
  listMemoriesTool,
  mountMemoryTools,
  recallTool,
  rememberTool,
} from './memory-tools.js'

const ctx: ToolExecutionContext = {
  taskId: 'task-1',
  signal: new AbortController().signal,
}

describe('rememberTool', () => {
  it('has safe permission level', () => {
    const provider = new InMemoryMemoryProvider()
    const tool = rememberTool(provider, 'test-user')
    expect(tool.name).toBe(REMEMBER_TOOL)
    expect(tool.permissionLevel).toBe('safe')
  })

  it('fails if content is missing or whitespace', async () => {
    const provider = new InMemoryMemoryProvider()
    const tool = rememberTool(provider, 'test-user')

    expect(await tool.execute({}, ctx)).toEqual({
      ok: false,
      content: '',
      error: 'content is required',
    })

    expect(await tool.execute({ content: '   ' }, ctx)).toEqual({
      ok: false,
      content: '',
      error: 'content is required',
    })
  })

  it('fails if content exceeds maximum length', async () => {
    const provider = new InMemoryMemoryProvider()
    const tool = rememberTool(provider, 'test-user')

    const result = await tool.execute({ content: 'x'.repeat(20001) }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/content is too long/)
  })

  it('successfully stores a fact and returns confirmation with id and containerTag', async () => {
    const provider = new InMemoryMemoryProvider()
    const tool = rememberTool(provider, 'user-42')

    const result = await tool.execute({ content: 'User prefers dark mode and tabs over spaces' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/Remembered fact in container "user-42" \(id: [a-f0-9-]+\)\./)

    const recalled = await provider.recall({ q: 'dark mode', containerTag: 'user-42' })
    expect(recalled.length).toBe(1)
    expect(recalled[0].content).toBe('User prefers dark mode and tabs over spaces')
  })

  it('passes metadata if provided', async () => {
    const provider = new InMemoryMemoryProvider()
    const spy = vi.spyOn(provider, 'remember')
    const tool = rememberTool(provider, 'user-42')

    await tool.execute({ content: 'Some fact', metadata: { type: 'preference', priority: 1 } }, ctx)
    expect(spy).toHaveBeenCalledWith({
      content: 'Some fact',
      containerTag: 'user-42',
      metadata: { type: 'preference', priority: 1 },
    })
  })

  it('handles provider error', async () => {
    const provider = new InMemoryMemoryProvider()
    vi.spyOn(provider, 'remember').mockRejectedValueOnce(new Error('Backend connection refused'))
    const tool = rememberTool(provider, 'user-42')

    const result = await tool.execute({ content: 'Important fact' }, ctx)
    expect(result).toEqual({
      ok: false,
      content: '',
      error: 'Failed to remember fact: Backend connection refused',
    })
  })
})

describe('recallTool', () => {
  it('has safe permission level', () => {
    const provider = new InMemoryMemoryProvider()
    const tool = recallTool(provider, 'test-user')
    expect(tool.name).toBe(RECALL_TOOL)
    expect(tool.permissionLevel).toBe('safe')
  })

  it('fails if query q is missing or empty', async () => {
    const provider = new InMemoryMemoryProvider()
    const tool = recallTool(provider, 'test-user')

    expect(await tool.execute({}, ctx)).toEqual({
      ok: false,
      content: '',
      error: 'query q is required',
    })

    expect(await tool.execute({ q: '   ' }, ctx)).toEqual({
      ok: false,
      content: '',
      error: 'query q is required',
    })
  })

  it('returns informative message when no memories match', async () => {
    const provider = new InMemoryMemoryProvider()
    const tool = recallTool(provider, 'test-user')

    const result = await tool.execute({ q: 'something completely non-existent' }, ctx)
    expect(result).toEqual({
      ok: true,
      content: 'No matching memories found for "something completely non-existent".',
    })
  })

  it('recalls matching memories and formats score and content', async () => {
    const provider = new InMemoryMemoryProvider()
    await provider.remember({ content: 'Project uses TypeScript and Vite', containerTag: 'project-1' })
    await provider.remember({ content: 'Project uses Vitest for testing', containerTag: 'project-1' })
    await provider.remember({ content: 'Other project uses Python', containerTag: 'project-2' })

    const tool = recallTool(provider, 'project-1')
    const result = await tool.execute({ q: 'TypeScript Vite' }, ctx)

    expect(result.ok).toBe(true)
    expect(result.content).toContain('Project uses TypeScript and Vite')
    expect(result.content).not.toContain('Other project uses Python')
    expect(result.content).toMatch(/score: \d+\.\d{2}/)
  })

  it('respects limit and clamps to max 50', async () => {
    const provider = new InMemoryMemoryProvider()
    const spy = vi.spyOn(provider, 'recall')
    const tool = recallTool(provider, 'user-1')

    await tool.execute({ q: 'test', limit: 3 }, ctx)
    expect(spy).toHaveBeenCalledWith({ q: 'test', containerTag: 'user-1', limit: 3 })

    await tool.execute({ q: 'test', limit: 100 }, ctx)
    expect(spy).toHaveBeenCalledWith({ q: 'test', containerTag: 'user-1', limit: 50 })
  })

  it('handles provider error', async () => {
    const provider = new InMemoryMemoryProvider()
    vi.spyOn(provider, 'recall').mockRejectedValueOnce(new Error('Network timeout'))
    const tool = recallTool(provider, 'user-1')

    const result = await tool.execute({ q: 'test' }, ctx)
    expect(result).toEqual({
      ok: false,
      content: '',
      error: 'Failed to recall memories: Network timeout',
    })
  })
})

describe('forgetTool', () => {
  it('has safe permission level', () => {
    const provider = new InMemoryMemoryProvider()
    const tool = forgetTool(provider, 'test-user')
    expect(tool.name).toBe(FORGET_TOOL)
    expect(tool.permissionLevel).toBe('safe')
  })

  it('requires either id or content', async () => {
    const provider = new InMemoryMemoryProvider()
    const tool = forgetTool(provider, 'test-user')

    expect(await tool.execute({}, ctx)).toEqual({
      ok: false,
      content: '',
      error: 'provide either memory id or content to forget',
    })
  })

  it('forgets by ID', async () => {
    const provider = new InMemoryMemoryProvider()
    const { id } = await provider.remember({ content: 'Deprecated workflow guideline', containerTag: 'user-1' })

    const tool = forgetTool(provider, 'user-1')
    const result = await tool.execute({ id, reason: 'No longer accurate' }, ctx)

    expect(result).toEqual({
      ok: true,
      content: `Memory successfully forgotten (id: ${id}).`,
    })

    const remaining = await provider.recall({ q: 'Deprecated', containerTag: 'user-1' })
    expect(remaining.length).toBe(0)
  })

  it('forgets by exact content match', async () => {
    const provider = new InMemoryMemoryProvider()
    await provider.remember({ content: 'Temporary note to remove', containerTag: 'user-1' })

    const tool = forgetTool(provider, 'user-1')
    const result = await tool.execute({ content: 'Temporary note to remove' }, ctx)

    expect(result).toEqual({
      ok: true,
      content: 'Memory successfully forgotten (content: "Temporary note to remove").',
    })

    const remaining = await provider.recall({ q: 'Temporary', containerTag: 'user-1' })
    expect(remaining.length).toBe(0)
  })

  it('returns failure when no memory matches', async () => {
    const provider = new InMemoryMemoryProvider()
    const tool = forgetTool(provider, 'user-1')

    const result = await tool.execute({ id: 'non-existent-id' }, ctx)
    expect(result).toEqual({
      ok: false,
      content: '',
      error: 'No matching memory found to forget, or it was already forgotten.',
    })
  })

  it('handles provider error', async () => {
    const provider = new InMemoryMemoryProvider()
    vi.spyOn(provider, 'forget').mockRejectedValueOnce(new Error('Database unavailable'))
    const tool = forgetTool(provider, 'user-1')

    const result = await tool.execute({ id: 'some-id' }, ctx)
    expect(result).toEqual({
      ok: false,
      content: '',
      error: 'Failed to forget memory: Database unavailable',
    })
  })
})

describe('listMemoriesTool', () => {
  it('has safe permission level', () => {
    const provider = new InMemoryMemoryProvider()
    const tool = listMemoriesTool(provider, 'test-user')
    expect(tool.name).toBe(LIST_MEMORIES_TOOL)
    expect(tool.permissionLevel).toBe('safe')
  })

  it('lists stored memories newest first', async () => {
    const provider = new InMemoryMemoryProvider()
    await provider.remember({ content: 'Memory 1', containerTag: 'tag-a' })
    await provider.remember({ content: 'Memory 2', containerTag: 'tag-a' })

    const tool = listMemoriesTool(provider, 'tag-a')
    const result = await tool.execute({}, ctx)

    expect(result.ok).toBe(true)
    expect(result.content).toContain('Stored memories in container "tag-a" (2):')
    expect(result.content).toContain('Memory 1')
    expect(result.content).toContain('Memory 2')
  })

  it('returns message when container has no memories', async () => {
    const provider = new InMemoryMemoryProvider()
    const tool = listMemoriesTool(provider, 'empty-tag')
    const result = await tool.execute({}, ctx)

    expect(result).toEqual({
      ok: true,
      content: 'No memories stored in container yet.',
    })
  })

  it('returns informative message when provider does not implement list', async () => {
    const mockProvider: MemoryProvider = {
      name: 'no-list-provider',
      async remember() {
        return { id: '1' }
      },
      async recall() {
        return []
      },
      async profile() {
        return { static: [], dynamic: [] }
      },
      async forget() {
        return { forgotten: true }
      },
      async update() {
        return { updated: true }
      },
    }

    const tool = listMemoriesTool(mockProvider, 'tag-1')
    const result = await tool.execute({}, ctx)

    expect(result).toEqual({
      ok: true,
      content:
        'The memory provider (no-list-provider) does not support listing all memories directly. Use recall to search memories instead.',
    })
  })

  it('handles provider error', async () => {
    const provider = new InMemoryMemoryProvider()
    vi.spyOn(provider, 'list').mockRejectedValueOnce(new Error('Disk read error'))
    const tool = listMemoriesTool(provider, 'tag-1')

    const result = await tool.execute({}, ctx)
    expect(result).toEqual({
      ok: false,
      content: '',
      error: 'Failed to list memories: Disk read error',
    })
  })
})

describe('mountMemoryTools', () => {
  it('registers all 4 memory tools and cleanly unregisters them when disposed', () => {
    const registry = new ToolRegistry()
    const provider = new InMemoryMemoryProvider()
    const dispose = mountMemoryTools(registry, provider, 'test-container')

    expect(registry.get(REMEMBER_TOOL)).toBeDefined()
    expect(registry.get(RECALL_TOOL)).toBeDefined()
    expect(registry.get(FORGET_TOOL)).toBeDefined()
    expect(registry.get(LIST_MEMORIES_TOOL)).toBeDefined()

    dispose()

    expect(registry.get(REMEMBER_TOOL)).toBeUndefined()
    expect(registry.get(RECALL_TOOL)).toBeUndefined()
    expect(registry.get(FORGET_TOOL)).toBeUndefined()
    expect(registry.get(LIST_MEMORIES_TOOL)).toBeUndefined()
  })
})
