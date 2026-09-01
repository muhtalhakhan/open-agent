import type { Context, Plugin } from '@open-agent/context'
import { SessionLog } from './session.js'
import { ToolRegistry } from './tools.js'
import { AgentLoop, type AgentLoopOptions } from './agent-loop.js'
import type { LlmAdapter } from './types.js'
import type { Logger } from './logger.js'

/** Mounts `ctx.sessions`: the append-only session event log. */
export const sessionPlugin: Plugin = (ctx: Context) => {
  ctx.set('sessions', new SessionLog())
}

/** Mounts `ctx.tools`: the scoped tool registry and execution pipeline. */
export const toolsPlugin: Plugin = (ctx: Context) => {
  ctx.set('tools', new ToolRegistry())
}

/** Mounts `ctx.llm`: the single active model adapter for this context. */
export function llmPlugin(adapter: LlmAdapter): Plugin {
  return (ctx: Context) => {
    ctx.set('llm', adapter)
  }
}

/**
 * Mounts `ctx.agentLoop`, the default driver of the agent interface.
 * Declares `inject: ['sessions', 'tools', 'llm']` so it only activates once
 * those seams exist, regardless of mount order.
 */
export function agentLoopPlugin(
  options: Omit<AgentLoopOptions, 'sessions' | 'tools' | 'llm'> & { logger?: Logger } = {},
): Plugin {
  return {
    inject: ['sessions', 'tools', 'llm'],
    apply(ctx: Context) {
      const loop = new AgentLoop({
        sessions: ctx.get('sessions')!,
        tools: ctx.get('tools')!,
        llm: ctx.get('llm')!,
        ...options,
      })
      ctx.set('agentLoop', loop)
    },
  }
}
