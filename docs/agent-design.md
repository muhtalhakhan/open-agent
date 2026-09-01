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

Profiles live under `examples/profiles/` and are loaded by both the CLI and web UI.

## Tool interface

Every tool implements:

```
name: string
description: string
schema: JSON schema for arguments
permissionLevel: "safe" | "ask" | "dangerous"
execute(args, context): Promise<ToolResult>
```

Tools are registered in a `ToolRegistry` that the agent loop queries by profile. MCP servers are exposed as tools through the same interface via the MCP client (`packages/tools/mcp`).

## Provider interface

```
generate(messages, options): Response
stream(messages, options): AsyncIterable<Chunk>
toolCall(messages, tools, options): ToolCallResponse
vision(messages, images, options): Response
```

Provider config is `{ provider, model, apiKey, baseUrl? }` — enough to add any OpenAI-compatible endpoint (LM Studio, self-hosted vLLM, etc.) without new code, and a dedicated adapter only when a provider's API shape diverges (Anthropic, Gemini).

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

`containerTag` scopes memories the same way an agent profile scopes tools — typically a user id, but a task, project, or client id works too. `SupermemoryProvider` (backed by [Supermemory](https://github.com/supermemoryai/supermemory), hosted or self-hosted via `supermemory-server`) is the reference implementation; `InMemoryMemoryProvider` is a dependency-free fallback for tests and offline use. Mounted as `ctx.memory` via `memoryPlugin`, same pattern as `ctx.llm` and `ctx.tools`.

Memory must be inspectable and deletable by the user — `forget()` is the privacy-control primitive; see `docs/security-model.md`.
