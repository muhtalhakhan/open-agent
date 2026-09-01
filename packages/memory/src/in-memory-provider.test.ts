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

  it('splits a container’s memories into static/dynamic halves for the profile', async () => {
    const memory = new InMemoryMemoryProvider()
    await memory.remember({ content: 'fact A', containerTag: 'user_1' })
    await memory.remember({ content: 'fact B', containerTag: 'user_1' })
    const profile = await memory.profile('user_1')
    expect(profile.static.length + profile.dynamic.length).toBe(2)
  })
})
