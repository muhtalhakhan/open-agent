import type { Context, Plugin } from '@open-agent/context'
import type { MemoryProvider } from './types.js'

/** Mounts `ctx.memory`: the single active memory provider for this context. */
export function memoryPlugin(provider: MemoryProvider): Plugin {
  return (ctx: Context) => {
    ctx.set('memory', provider)
  }
}
