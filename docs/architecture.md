# Architecture

## Goal

A provider-agnostic agent runtime that can eventually become a full computer-using personal agent, built so that new capabilities (tools, providers, integrations) can be added without modifying the core.

## Request flow

```
User
 ↓
UI (web/cli)
 ↓
API
 ↓
Agent Runtime
 ↓
Planner (LLM call: decide next action)
 ↓
Tool Registry
 ↓
Tool (browser / filesystem / shell / computer / MCP tool)
 ↓
Result
 ↓
Model (next turn)
 ↓
Next action or final response
```

The agent loop repeats "ask the model for the next action → execute a tool → feed the result back" until the model produces a final answer, hits a limit, is cancelled, or is blocked pending human approval.

## MVP (v0.1)

```
User → Web UI → Agent Runtime → { LLM Provider, Browser, Filesystem, Terminal }
```

Success criterion: "Open a browser, search for the latest AI news, summarize the results, and save the summary to report.md" works reliably end-to-end.

## Core architectural rules

### 1. Every capability is a tool

The agent core never talks to Chrome, the filesystem, or a shell directly. It only knows about a `ToolRegistry` and calls `tool.execute(args)`. New capabilities (Gmail, GitHub, Slack, Postgres, Spotify, Notion, ...) are added as new tools under `packages/tools/`, without touching `packages/agent/`.

```
Agent → Tool Registry → browser.navigate() / browser.click() / browser.type()
                       → computer.screenshot()
                       → filesystem.write()
                       → shell.execute()
```

### 2. Providers are interchangeable

The agent only sees a provider interface:

```
generate()
stream()
tool_call()
vision()
```

It never knows whether the backend is OpenAI, Gemini, Claude, Grok, DeepSeek, OpenRouter, Ollama, LM Studio, or a custom endpoint. Switching providers is a config change:

```yaml
provider: openrouter
model: some-model
```

### 3. Agent profiles

A profile is a named bundle of {model, enabled tools, permission policy}. This is how OpenAgent supports very different use cases (a read-only research agent vs. a coding agent with shell+Docker vs. a personal assistant with email/calendar) without needing separate codebases. See `docs/agent-design.md`.

### 4. Security is not a layer on top

Tool execution passes through the permission/approval system (`packages/security`) before running, not after. See `docs/security-model.md`.

## Repository structure

```
apps/
  web/         Web UI (chat + task view + approval prompts)
  cli/         Command-line interface
packages/
  agent/       Agent loop, conversation/task state, cancellation, retries, logging
  providers/   Provider abstraction + implementations (OpenAI, Gemini, Anthropic, OpenRouter, Ollama, generic OpenAI-compatible)
  tools/       Built-in tools: browser, computer use, filesystem, shell, MCP client
  memory/      Conversation memory, task history, long-term/semantic memory, preferences
  security/    Permission system, approval UI hooks, sandboxing, audit logs
docs/          Architecture, agent design, security model
tests/         Cross-package integration tests
examples/      Example agent profiles and scripts
docker/        Container definitions for sandboxed execution
```

## Language choice

TypeScript-first across `apps/` and `packages/` for a unified type system between the runtime, tool interfaces, and web UI. Individual tools (e.g. computer-use/vision helpers) may shell out to Python where the ecosystem is stronger, but the agent core and tool contracts are TypeScript.

## Kernel: plugins, services, events

`packages/context` implements the mechanism the rules above rely on, inspired by the plugin kernel ([Cordis](https://github.com/cordiverse/cordis)) underneath [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — re-derived at a much smaller scale, not ported:

- A **context** is a repository of services keyed by name (`ctx.get('tools')`, `ctx.get('llm')`, `ctx.get('sessions')`). A service claims one key; other code finds it by key instead of importing a concrete implementation — this is what makes providers and tools swappable from configuration rather than code.
- A **plugin** registers services/listeners on a context, and can declare `inject: [...]` dependencies so it only activates once those services exist, regardless of mount order.
- **Events** have five dispatch modes — `emit` (fire-and-forget), `waterfall` (around-middleware that can rewrite or short-circuit a decision), `parallel`, `serial`, `bail` (first defined result wins) — used for interception and policy (e.g. a tool's `ask`/`dangerous` approval gate).
- **Registrations are reversible effects**: whatever a plugin registers unwinds when it's disposed.

`packages/agent` builds the turn/step agent loop, the session event log, and the tool registry as plugins on top of this kernel (`ctx.sessions`, `ctx.tools`, `ctx.llm`, `ctx.agentLoop`). A **turn** is one full run of a task; a **step** is one model request plus the tools it calls. The session log is append-only and is the only source the model-visible message history is projected from — this is also what conversation/task state, replay, and audit logging derive from. See `packages/agent/README.md` for the concrete API.
