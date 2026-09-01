import { describe, expect, it } from 'vitest'
import { Context } from '@open-agent/context'
import { memoryPlugin } from './plugins.js'
import { InMemoryMemoryProvider } from './in-memory-provider.js'

describe('memoryPlugin', () => {
  it('mounts the given provider as ctx.memory', () => {
    const ctx = new Context()
    const provider = new InMemoryMemoryProvider()
    ctx.plugin(memoryPlugin(provider))
    expect(ctx.get('memory')).toBe(provider)
  })
})
