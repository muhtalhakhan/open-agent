import { describe, expect, it, vi } from 'vitest'
import { Context } from './context.js'

describe('Context', () => {
  it('registers and looks up services', () => {
    const ctx = new Context()
    ctx.set('greeting', 'hello')
    expect(ctx.get('greeting')).toBe('hello')
  })

  it('throws when a service key is registered twice', () => {
    const ctx = new Context()
    ctx.set('x', 1)
    expect(() => ctx.set('x', 2)).toThrow()
  })

  it('disposing a service removes it', () => {
    const ctx = new Context()
    const dispose = ctx.set('x', 1)
    dispose()
    expect(ctx.get('x')).toBeUndefined()
  })

  it('activates a plugin immediately when its dependencies are met', () => {
    const ctx = new Context()
    ctx.set('db', { ready: true })
    const apply = vi.fn()
    ctx.plugin({ inject: ['db'], apply })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('defers a plugin until its injected service appears', () => {
    const ctx = new Context()
    const apply = vi.fn()
    ctx.plugin({ inject: ['db'], apply })
    expect(apply).not.toHaveBeenCalled()
    ctx.set('db', { ready: true })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('tears down everything a plugin registered when disposed', () => {
    const ctx = new Context()
    const cleanup = vi.fn()
    const dispose = ctx.plugin((scope) => {
      scope.on('ping', () => {})
      return cleanup
    })
    expect(ctx.emit('ping')).toBeUndefined()
    dispose()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('waterfall lets listeners wrap and short-circuit', () => {
    const ctx = new Context()
    ctx.on('greet', (value: string, next: (v: string) => string) => next(value + ' world'))
    ctx.on('greet', (value: string) => value + '!')
    expect(ctx.waterfall('greet', 'hello')).toBe('hello world!')
  })

  it('bail stops at the first defined result', () => {
    const ctx = new Context()
    ctx.on('policy', () => undefined)
    ctx.on('policy', () => 'ask')
    ctx.on('policy', () => 'dangerous')
    expect(ctx.bail('policy')).toBe('ask')
  })

  it('serial awaits listeners in order and collects results', async () => {
    const ctx = new Context()
    const order: number[] = []
    ctx.on('step', async () => {
      await new Promise((r) => setTimeout(r, 5))
      order.push(1)
      return 'a'
    })
    ctx.on('step', async () => {
      order.push(2)
      return 'b'
    })
    const results = await ctx.serial('step')
    expect(order).toEqual([1, 2])
    expect(results).toEqual(['a', 'b'])
  })
})
