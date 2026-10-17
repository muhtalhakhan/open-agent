import { describe, expect, it } from 'vitest'
import { InMemoryMemoryProvider } from './in-memory-provider.js'

describe('InMemoryMemoryProvider', () => {
  it('recalls memories that share words with the query, scoped by containerTag', async () => {
    const memory = new InMemoryMemoryProvider()
    await memory.remember({ content: 'User loves TypeScript and functional patterns', containerTag: 'user_1' })
    await memory.remember({ content: 'User prefers dark mode', containerTag: 'user_1' })
    await memory.remember({ content: 'Unrelated fact about a different user', containerTag: 'user_2' })

    const results = await memory.recall({ q: 'TypeScript', containerTag: 'user_1' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toMatch(/TypeScript/)
  })

  it('forget() soft-deletes so the entry no longer surfaces in recall or profile', async () => {
    const memory = new InMemoryMemoryProvider()
    const { id } = await memory.remember({ content: 'temporary fact', containerTag: 'user_1' })
    expect((await memory.profile('user_1')).static).toContain('temporary fact')

    const result = await memory.forget({ containerTag: 'user_1', id })
    expect(result.forgotten).toBe(true)
    expect((await memory.profile('user_1')).static).not.toContain('temporary fact')
    expect(await memory.recall({ q: 'temporary', containerTag: 'user_1' })).toHaveLength(0)
  })

  it('forget() returns false when nothing matches', async () => {
    const memory = new InMemoryMemoryProvider()
    const result = await memory.forget({ containerTag: 'user_1', id: 'does-not-exist' })
    expect(result.forgotten).toBe(false)
  })

  it('update() edits content and metadata of an existing memory', async () => {
    const memory = new InMemoryMemoryProvider()
    const { id } = await memory.remember({ content: 'original', containerTag: 'user_1', metadata: { v: 1 } })
    const updated = await memory.update({ id, containerTag: 'user_1', content: 'updated', metadata: { v: 2 } })
    expect(updated.updated).toBe(true)
    const results = await memory.recall({ q: 'updated', containerTag: 'user_1' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('updated')
  })

  it('update() refuses to edit a forgotten memory', async () => {
    const memory = new InMemoryMemoryProvider()
    const { id } = await memory.remember({ content: 'original', containerTag: 'user_1' })
    await memory.forget({ id, containerTag: 'user_1' })
    expect(await memory.update({ id, containerTag: 'user_1', content: 'revived' })).toEqual({ updated: false })
  })

  it('update() returns false for unknown id', async () => {
    const memory = new InMemoryMemoryProvider()
    const result = await memory.update({ id: 'no-such-id', containerTag: 'user_1', content: 'x' })
    expect(result.updated).toBe(false)
  })

  it('splits a container’s memories into static/dynamic halves for the profile', async () => {
    const memory = new InMemoryMemoryProvider()
    await memory.remember({ content: 'fact A', containerTag: 'user_1' })
    await memory.remember({ content: 'fact B', containerTag: 'user_1' })
    const profile = await memory.profile('user_1')
    expect(profile.static.length + profile.dynamic.length).toBe(2)
  })

  it("lists a container's live memories, newest first, leaving out forgotten ones and other containers", async () => {
    const memory = new InMemoryMemoryProvider()
    const { id: first } = await memory.remember({ content: 'prefers tabs', containerTag: 'u1' })
    await memory.remember({ content: 'lives in Lahore', containerTag: 'u1' })
    await memory.remember({ content: 'someone else', containerTag: 'u2' })
    const { id: gone } = await memory.remember({ content: 'outdated', containerTag: 'u1' })
    await memory.forget({ containerTag: 'u1', id: gone })

    const listed = await memory.list('u1')

    expect(listed.map((m) => m.content)).toEqual(['lives in Lahore', 'prefers tabs'])
    expect(listed[1].id).toBe(first)
    expect(await memory.list('u1', { limit: 1 })).toHaveLength(1)
  })
})
