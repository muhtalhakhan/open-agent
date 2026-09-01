import { describe, expect, it, vi } from 'vitest'
import { Mem0Provider } from './mem0-provider.js'
import type { Mem0ClientLike } from './mem0-provider.js'

function fakeClient(overrides: Partial<Mem0ClientLike> = {}): Mem0ClientLike {
  return {
    add: vi.fn().mockResolvedValue([{ id: 'm0-1' }]),
    search: vi.fn().mockResolvedValue({ results: [{ id: 'm0-1', memory: 'User loves TypeScript', score: 0.87 }] }),
    getAll: vi.fn().mockResolvedValue({ results: [{ id: 'm0-1', memory: 'User loves TypeScript' }] }),
    delete: vi.fn().mockResolvedValue({ message: 'deleted' }),
    ...overrides,
  }
}

describe('Mem0Provider', () => {
  it('remember() adds a user-role message scoped by userId', async () => {
    const client = fakeClient()
    const provider = new Mem0Provider(client)
    const { id } = await provider.remember({ content: 'loves TS', containerTag: 'user_123' })
    expect(id).toBe('m0-1')
    expect(client.add).toHaveBeenCalledWith([{ role: 'user', content: 'loves TS' }], {
      userId: 'user_123',
      metadata: undefined,
    })
  })

  it('recall() maps search results into MemorySearchResult', async () => {
    const provider = new Mem0Provider(fakeClient())
    const results = await provider.recall({ q: 'programming style', containerTag: 'user_123', limit: 5 })
    expect(results).toEqual([{ id: 'm0-1', content: 'User loves TypeScript', score: 0.87, metadata: undefined }])
  })

  it('profile() puts every memory under static, since mem0 has no static/dynamic split', async () => {
    const provider = new Mem0Provider(fakeClient())
    const profile = await provider.profile('user_123')
    expect(profile).toEqual({ static: ['User loves TypeScript'], dynamic: [] })
  })

  it('forget() deletes by id', async () => {
    const client = fakeClient()
    const provider = new Mem0Provider(client)
    const result = await provider.forget({ containerTag: 'user_123', id: 'm0-1' })
    expect(result).toEqual({ forgotten: true })
    expect(client.delete).toHaveBeenCalledWith('m0-1')
  })

  it('forget() without an id returns false rather than guessing', async () => {
    const provider = new Mem0Provider(fakeClient())
    const result = await provider.forget({ containerTag: 'user_123', content: 'loves TS' })
    expect(result).toEqual({ forgotten: false })
  })
})
