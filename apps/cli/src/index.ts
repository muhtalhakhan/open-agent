#!/usr/bin/env -S npx tsx
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import dotenv from 'dotenv'
import { AgentLoop, SessionLog, ToolRegistry, consoleLogger, silentLogger } from '@open-agent/agent'
import { InMemoryMemoryProvider, Mem0Provider, SupermemoryProvider, memoryPlugin } from '@open-agent/memory'
import type { MemoryProvider } from '@open-agent/memory'
import { OpenAiCompatibleProvider } from '@open-agent/providers'
import { mountBrowserUseTools } from '@open-agent/tools-browser'
import { Context } from '@open-agent/context'
import { loadConfigFromEnv } from './config.js'
import { createTerminalApprovalHandler } from './approval.js'
import { runRepl, type AbortRef, type ReplIO } from './repl.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// apps/cli/src -> apps/cli -> apps -> repo root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') })

/**
 * The Ink TUI needs a real TTY on both ends to take over the screen. Fall
 * back to the plain readline REPL for anything else (CI, `| cat`, piped
 * input/output, etc) — set `CLI_NO_TUI=1` to force the fallback locally
 * (in the shell or in `.env`, since dotenv has already loaded above).
 */
const useTui = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !process.env.CLI_NO_TUI

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
  const activeAbort: AbortRef = { current: null }

  let io: ReplIO
  let ask: (question: string) => Promise<string>
  let teardown: () => void

  if (useTui) {
    const { mountTui } = await import('./tui/mount.js')
    const tui = mountTui({
      onInterrupt: () => {
        if (activeAbort.current) {
          tui.io.setStatus('[cancelling current task...]')
          activeAbort.current.abort()
        } else {
          tui.unmount()
          process.exit(0)
        }
      },
    })
    io = tui.io
    ask = tui.io.ask
    teardown = () => tui.unmount()
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    io = {
      async prompt() {
        try {
          return await rl.question('> ')
        } catch {
          return null // readline closed (e.g. Ctrl+D)
        }
      },
      write: (text) => process.stdout.write(text),
    }
    ask = (question) => rl.question(question)
    process.on('SIGINT', () => {
      if (activeAbort.current) {
        console.log('\n[cancelling current task...]')
        activeAbort.current.abort()
      } else {
        rl.close()
        process.exit(0)
      }
    })
    teardown = () => rl.close()
  }

  tools.onApproval(createTerminalApprovalHandler(ask))

  let disposeBrowserTools: (() => void) | undefined
  if (config.browserUse) {
    console.log('Starting browser-use (python -m browser_use.mcp)...')
    disposeBrowserTools = await mountBrowserUseTools(tools)
  }

  if (config.memory.provider === 'supermemory') {
    const { default: Supermemory } = await import('supermemory')
    ctx.plugin(
      memoryPlugin(
        new SupermemoryProvider(new Supermemory({ apiKey: config.memory.apiKey, baseURL: config.memory.baseURL })),
      ),
    )
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

  try {
    const memory = ctx.get<MemoryProvider>('memory')!
    const containerTag = process.env.CLI_USER_ID ?? 'cli-user'
    await runRepl(loop, sessions, io, activeAbort, {
      provider: memory,
      containerTag,
    })
  } finally {
    teardown()
    disposeBrowserTools?.()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
