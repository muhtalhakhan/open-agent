# @open-agent/agent

The agent runtime: the turn/step loop, the tool registry and execution pipeline, the append-only session log, and the provider seam — built on top of `@open-agent/context`.

## Pieces

- **`SessionLog`** (`src/session.ts`) — the append-only, durable fact log for a task. `deriveMessages()` projects the model-visible history from it. Nothing reaches the model unless it was appended here first.
- **`ToolRegistry`** (`src/tools.ts`) — registers tools, each declaring a `permissionLevel` (`safe` / `ask` / `dangerous`), and guards execution behind an approval handler. Every call is recorded in `auditLog`.
- **`AgentLoop`** (`src/agent-loop.ts`) — a turn is the whole run; a step is one model request plus the tools it calls. Handles retries on transient provider errors, cancellation via `AbortSignal`, and a `maxSteps` safety valve against runaway tool-calling.
- **`plugins.ts`** — mounts the above onto a `Context` as `ctx.sessions`, `ctx.tools`, `ctx.llm`, `ctx.agentLoop`, demonstrating the "everything is a plugin" pattern from `docs/architecture.md`.

## Example

```ts
import { Context } from '@open-agent/context'
import { sessionPlugin, toolsPlugin, llmPlugin, agentLoopPlugin } from '@open-agent/agent'
import type { LlmAdapter } from '@open-agent/agent'

const ctx = new Context()
ctx.plugin(sessionPlugin)
ctx.plugin(toolsPlugin)
ctx.plugin(llmPlugin(myProvider satisfies LlmAdapter))
ctx.plugin(agentLoopPlugin())

ctx.get('tools')!.register(myTool)

const result = await ctx.get('agentLoop')!.run('summarize the latest AI news', new AbortController().signal)
```

This fills in Milestone 1 (Agent Runtime): agent interface, agent loop, tool interface/registry/execution, conversation/task state, cancellation, retries, and structured logging (`src/logger.ts`).

Providers (`packages/providers`) implement `LlmAdapter` from `src/types.ts`; browser/filesystem/shell tools (`packages/tools`) implement `ToolDefinition`.
