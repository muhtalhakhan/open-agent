# Agent Design

## The agent loop

1. Receive a task (user message, scheduled trigger, or API call).
2. Build context: conversation state, task state, relevant memory, available tools for the active profile.
3. Call the model provider for the next action (a message, a tool call, or a final answer).
4. If it's a tool call: check permissions → execute (or request human approval) → append the result to context → go to 3.
5. If it's a final answer: return it, persist to history, stop.

The loop must support: cancellation mid-task, retries on transient provider/tool failures, and structured logging of every step for audit/debugging.

## Agent profiles

A profile declares which model and which tools an agent instance may use, plus the default permission policy for each tool. This is the primary way OpenAgent scales to many use cases without a monolithic "do everything" agent.

```yaml
name: Research Agent
model: gemini/gemini-2.5-pro
tools:
  browser: true
  filesystem: true
  terminal: false
memory: true
```

```yaml
name: Coding Agent
model: anthropic/claude-sonnet
tools:
  browser: true
  filesystem: true
  terminal: true
  docker: true
```

```yaml
name: Personal Assistant
model: openai/gpt-5
tools:
  browser: true
  email: true
  calendar: true
memory: true
permissions:
  email.send: ask
```

Profiles are a design target, not yet implemented — today's CLI wires up a single fixed set of tools/permissions per run (see `apps/cli/README.md`). `examples/profiles/` and profile loading in the CLI/web UI are planned (Milestone 11).

## Tool interface

Every tool implements:

```
name: string
description: string
schema: JSON schema for arguments
permissionLevel: "safe" | "ask" | "dangerous"
execute(args, context): Promise<ToolResult>
```

Tools are registered in a `ToolRegistry` that the agent loop queries by profile. MCP servers are exposed as tools through the same interface via the generic MCP client (`packages/tools-mcp`), which `tools-browser` and `tools-computer` both build on.

## Provider interface

```
generate(messages, options): Response
stream(messages, options): AsyncIterable<Chunk>
toolCall(messages, tools, options): ToolCallResponse
vision(messages, images, options): Response
```

Provider config is `{ provider, model, apiKey, baseUrl? }` — enough to add any OpenAI-compatible endpoint (LM Studio, self-hosted vLLM, etc.) without new code, and a dedicated adapter only when a provider's API shape diverges (Anthropic, Gemini).

`packages/providers`'s `OpenAiCompatibleProvider` is the first concrete `LlmAdapter`: point `baseURL`/`apiKey`/`model` at OpenAI, OpenRouter, Ollama, or LM Studio and it works unchanged — the whole point of the seam.

## Memory model

- **Conversation memory**: the current task's message history — this is `SessionLog` in `packages/agent`, not `packages/memory`.
- **Task history**: past completed/failed tasks, queryable by the user.
- **Long-term memory**: durable facts/preferences extracted across tasks, retrievable via semantic search.
- **User preferences**: explicit settings (tone, default profile, approval defaults).

Long-term memory and user preferences go through `packages/memory`'s `MemoryProvider` seam:

```
remember(entry: { content, containerTag, metadata? }): { id }
recall(query: { q, containerTag, mode?, limit? }): MemorySearchResult[]
profile(containerTag, q?): { static: string[], dynamic: string[] }
forget(request: { containerTag, id?, content?, reason? }): { forgotten }
```

`containerTag` scopes memories the same way an agent profile scopes tools — typically a user id, but a task, project, or client id works too. Two implementations ship behind the same seam, pick either: `SupermemoryProvider` (backed by [Supermemory](https://github.com/supermemoryai/supermemory), hosted or self-hosted via `supermemory-server`) has a built-in static/dynamic profile split; `Mem0Provider` (backed by [mem0](https://github.com/mem0ai/mem0)) scopes by `userId` and has no profile split of its own (`profile()` returns everything as `static`). `InMemoryMemoryProvider` is a dependency-free fallback for tests and offline use. Mounted as `ctx.memory` via `memoryPlugin`, same pattern as `ctx.llm` and `ctx.tools`.

Memory must be inspectable and deletable by the user — `forget()` is the privacy-control primitive; see `docs/security-model.md`.

## Computer use

`packages/tools-computer` follows the same delegation pattern as browser tools' `retry_with_browser_use_agent`: `computer_use_task` hands a task to a full screenshot -> model-prediction -> mouse/keyboard-action loop (real implementation: [`@ui-tars/sdk`](https://github.com/bytedance/UI-TARS-desktop)'s `GUIAgent` + `@ui-tars/operator-nut-js` for native OS control) via an injected `GuiAgentFactory`, so it's testable without a real display. `computer_screenshot` is a standalone `safe` tool for when the model just needs to look. Both are `ask`/`safe`-gated per `docs/security-model.md` — see the package README for the reasoning.
