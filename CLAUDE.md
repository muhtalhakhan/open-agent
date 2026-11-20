# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

OpenAgent is a provider-agnostic AI agent platform that gives users control over their own AI agents. It's a TypeScript monorepo using npm workspaces, designed to run locally, in Docker, or on cloud infrastructure.

## Essential Commands

**Development setup:**
```bash
npm install                    # Install all workspace dependencies
npm run cli -- init            # Setup wizard: provider, key, tools, writes .env
npm run cli                    # Run interactive terminal session
npm run web                    # Start web UI (builds and prints address)
```

**Quality checks (run before every PR):**
```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:integration
```

**Individual commands:**
```bash
npm run format:check       # Prettier (use `npm run format` to fix)
npm run lint               # ESLint (use `npm run lint:fix` to auto-fix)
npm run typecheck          # TypeScript strict mode, no emit
npm test                   # All unit tests (no API keys needed)
npm run test:integration   # Spawns real CLI against fake provider (slower)
npx vitest path/to/file.test.ts  # Single test file
```

## Architecture Principles

### Core Invariants

1. **The session log is the source of truth.** Nothing reaches the model unless appended to `SessionLog` first. Don't inject at request time what isn't in the log.

2. **Every capability is a tool.** The agent core never talks directly to Chrome, filesystem, or shell — only through `ToolRegistry`. New capabilities go in `packages/tools-*` without touching `packages/agent/`.

3. **Providers are interchangeable.** `LlmAdapter` is just `name` + `generate()`. The agent core never special-cases providers. Provider-specific quirks (Anthropic's `system` parameter, Gemini's `systemInstruction`) are the adapter's responsibility to normalize.

4. **Security gates every call.** `ToolRegistry.decide` denies everything above `safe` by default. `dangerous` requires explicit `enableDangerous(name)`. Never route around this for convenience.

5. **The user's message is what they typed.** Background context (recalled memories, conventions) belongs in the system message via `RunOptions.context` or `systemPrompt`, never spliced into the user's text.

### Architecture

- **Plugin kernel** (`packages/context`): Small service/plugin system inspired by Cordis. Services are keyed repositories (`ctx.get('tools')`). Plugins declare dependencies via `inject: [...]`. Events support five modes: `emit`, `waterfall`, `parallel`, `serial`, `bail`.

- **Agent runtime** (`packages/agent`): Turn/step loop, session log, tool registry built as plugins on the kernel. A turn is one complete task run; a step is one model request plus tool calls it makes.

- **Provider abstraction** (`packages/providers`): `OpenAiCompatibleProvider` covers OpenAI, OpenRouter, Ollama, LM Studio, vLLM. Dedicated adapters: `AnthropicProvider`, `GeminiProvider`. `ProviderFallbackAdapter` tries adapters in order, falling through on 401/403/429 (auth/quota) and 408/502/503/504/529 (provider down/overloaded).

- **Tool packages** (`packages/tools-*`): Each capability is its own package implementing `ToolDefinition`. All tools declare a `permissionLevel: 'safe' | 'ask' | 'dangerous'`.

- **Security** (`packages/security`): OS keychain secret store. The permission/approval system lives in `packages/agent/src/tools.ts`.

### Monorepo Layout

```
apps/
  cli/          Ink-based TUI (src/index.ts is the only file touching stdin/stdout/env)
  web/          React web UI with chat, history, approvals, settings
packages/
  context/      Plugin/service kernel
  agent/        Agent loop, session log, tool registry
  providers/    LLM adapters (OpenAI-compatible, Anthropic, Gemini, fallback)
  tools-browser/    Browser tools via browser-use MCP server
  tools-computer/   Computer-use tools via @ui-tars/sdk
  tools-files/      Filesystem tools (workspace-confined, policy-enforced)
  tools-http/       Direct HTTP requests, fetch_url for page text
  tools-search/     Web search (Brave, Tavily)
  tools-terminal/   Sandboxed shell commands and background processes
  tools-git/        Git operations (safe reads, ask for writes)
  tools-mcp/        Generic MCP stdio client
  tools-vision/     Image analysis via vision model
  tools-todo/       Task checklist for multi-step work
  tools-decision/   Typed judgments from DecisionModel
  memory/           Long-term memory (Supermemory, mem0, in-memory)
  automation/       Task scheduler (cron, interval, one-time)
  security/         OS keychain secret stores
docs/               Architecture, agent design, security model
```

## Critical Implementation Details

### ESM and TypeScript
- Always use `.js` extensions in relative imports, even from `.ts` files (`import { foo } from './bar.js'`)
- Use `import type { ... }` for type-only imports (ESLint enforces this)
- Prettier: no semicolons, single quotes, 120 columns, trailing commas

### Tool Execution Pipeline
1. Model requests a tool call
2. `ToolRegistry.decide` checks permission level
3. If `ask` or `dangerous`, calls `ApprovalHandler` (terminal prompt or web UI)
4. `beforeCall` hooks run (can block, cannot approve)
5. Tool executes
6. `afterCall` hooks run (audit logging, etc.)
7. Result goes to model

### Session Log Flow
1. User message appended to `SessionLog`
2. `SessionLog` projected to `Message[]` for model
3. Model responds with text or tool calls
4. Response appended to `SessionLog`
5. Tool calls execute through `ToolRegistry`
6. Tool results appended to `SessionLog`
7. Repeat until final answer

### Testing Philosophy
- Unit tests run with no API keys or network (use injected fakes)
- Integration tests (`*.integration.test.ts`) spawn real CLI against fake provider on local socket
- CI runs both suites

## Common Pitfalls

1. **Don't bypass `ToolRegistry.decide`.** Every tool call must go through the permission system.

2. **Don't inject context into user messages.** Use `RunOptions.context` or system prompt for background information.

3. **Don't special-case providers in agent core.** Normalize provider quirks in adapters.

4. **Don't edit `main` directly.** Branch off `main`, open PR, pass CI.

5. **Don't forget the session log.** Everything the model sees must come from the log, not request-time injection.

6. **Don't use default exports except in Ink UI.** Everything else uses named exports.

7. **Don't touch real stdin/stdout outside `apps/cli/src/index.ts`.** Everything else takes injected IO for testability.