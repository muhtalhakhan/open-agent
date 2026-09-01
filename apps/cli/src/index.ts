#!/usr/bin/env -S npx tsx
import { createInterface } from 'node:readline/promises'
import { AgentLoop, SessionLog, ToolRegistry, consoleLogger, silentLogger } from '@open-agent/agent'
import { InMemoryMemoryProvider, Mem0Provider, SupermemoryProvider, memoryPlugin } from '@open-agent/memory'
import type { MemoryProvider } from '@open-agent/memory'
import { OpenAiCompatibleProvider } from '@open-agent/providers'
import { mountBrowserUseTools } from '@open-agent/tools-browser'
import { Context } from '@open-agent/context'
import { loadConfigFromEnv } from './config.js'
import { createTerminalApprovalHandler } from './approval.js'
import { runRepl, type AbortRef } from './repl.js'

async function main() {
  const result = loadConfigFromEnv(process.env)
  if (!result.ok) {
    console.error(result.error)
    process.exitCode = 1
    return
  }
  const { config } = result

  const ctx = new Context()
  const sessions = new SessionLog()
  const tools = new ToolRegistry()

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  tools.onApproval(createTerminalApprovalHandler((question) => rl.question(question)))

  let disposeBrowserTools: (() => void) | undefined
  if (config.browserUse) {
    console.log('Starting browser-use (python -m browser_use.mcp)...')
    disposeBrowserTools = await mountBrowserUseTools(tools)
  }

  if (config.memory.provider === 'supermemory') {
    const { default: Supermemory } = await import('supermemory')
    ctx.plugin(memoryPlugin(new SupermemoryProvider(new Supermemory({ apiKey: config.memory.apiKey, baseURL: config.memory.baseURL }))))
  } else if (config.memory.provider === 'mem0') {
    const { default: MemoryClient } = await import('mem0ai')
    ctx.plugin(memoryPlugin(new Mem0Provider(new MemoryClient({ apiKey: config.memory.apiKey }))))
  } else {
    ctx.plugin(memoryPlugin(new InMemoryMemoryProvider()))
  }

  const llm = new OpenAiCompatibleProvider(config.llm)
  const loop = new AgentLoop({
    sessions,
    tools,
    llm,
    logger: process.env.DEBUG ? consoleLogger : silentLogger,
  })

  const activeAbort: AbortRef = { current: null }
  process.on('SIGINT', () => {
    if (activeAbort.current) {
      console.log('\n[cancelling current task...]')
      activeAbort.current.abort()
    } else {
      rl.close()
      process.exit(0)
    }
  })

  try {
    const prompt = async () => {
      try {
        return await rl.question('> ')
      } catch {
        return null // readline closed (e.g. Ctrl+D)
      }
    }
    const memory = ctx.get<MemoryProvider>('memory')!
    const containerTag = process.env.CLI_USER_ID ?? 'cli-user'
    await runRepl(loop, sessions, { prompt, write: (text) => process.stdout.write(text) }, activeAbort, { provider: memory, containerTag })
  } finally {
    rl.close()
    disposeBrowserTools?.()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
