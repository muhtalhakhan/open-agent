#!/usr/bin/env -S npx tsx
/**
 * The original v0.1 success criterion from docs/architecture.md:
 *
 *   "Open a browser, search for the latest AI news, summarize the results,
 *    and save the summary to report.md."
 *
 * Run it (needs Python + browser-use installed — `pip install browser-use`
 * — and an OpenAI-compatible API key):
 *
 *   OPENAI_BASE_URL=https://api.openai.com/v1 \
 *   OPENAI_API_KEY=sk-... \
 *   OPENAI_MODEL=gpt-4o-mini \
 *   npx tsx examples/research-and-report.ts
 *
 * Swap OPENAI_BASE_URL/OPENAI_MODEL to point at OpenRouter, Ollama, or LM
 * Studio instead — OpenAiCompatibleProvider doesn't care which. Plain
 * `node` can't run this file directly pre-build (see CONTRIBUTING.md); tsx
 * resolves the workspace packages' TypeScript source on the fly.
 */
import { writeFile } from 'node:fs/promises'
import {
  AgentLoop,
  SessionLog,
  ToolRegistry,
  consoleLogger,
} from '@open-agent/agent'
import { OpenAiCompatibleProvider } from '@open-agent/providers'
import { mountBrowserUseTools } from '@open-agent/tools-browser'

async function main() {
  const baseURL = process.env.OPENAI_BASE_URL
  const apiKey = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL
  if (!baseURL || !apiKey || !model) {
    console.error('Set OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL (see the header comment in this file).')
    process.exitCode = 1
    return
  }

  const sessions = new SessionLog()
  const tools = new ToolRegistry()
  tools.onApproval(() => true) // this demo runs unattended; a real UI would prompt per docs/security-model.md

  console.log('Starting browser-use (python -m browser_use.mcp)...')
  const disposeBrowserTools = await mountBrowserUseTools(tools)

  const llm = new OpenAiCompatibleProvider({ baseURL, apiKey, model })
  const loop = new AgentLoop({ sessions, tools, llm, logger: consoleLogger, maxSteps: 15 })

  try {
    const task = await loop.run(
      'Search the web for the latest AI news, then write a concise Markdown summary of the top 3-5 stories. ' +
        'Respond with ONLY the Markdown summary as your final answer — no extra commentary.',
      new AbortController().signal,
    )

    if (task.status !== 'completed') {
      console.error(`Task did not complete: ${task.status}${task.error ? ` — ${task.error}` : ''}`)
      process.exitCode = 1
      return
    }

    const messages = sessions.deriveMessages(task.id)
    const summary = messages.at(-1)?.content ?? ''
    await writeFile('report.md', summary, 'utf-8')
    console.log('Wrote report.md')
  } finally {
    disposeBrowserTools()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
