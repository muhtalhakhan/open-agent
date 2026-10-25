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

The agent only sees a provider interface. The target shape is:

```
generate()
stream()
tool_call()
vision()
```

> **Status:** only `generate(request, signal, options?)` exists today. The
> implemented interface is `LlmAdapter` in `packages/agent/src/types.ts` —
> `name` plus `generate()` — and tool calls travel inside the ordinary
> request/response rather than through a separate method. Streaming is
> `options.onText` rather than a `stream()` method: an adapter that can stream
> reports text through it as it arrives and still resolves with the whole
> response, which is all the session log ever records. `tool_call()` and
> `vision()` are design targets, not code.

Beside it sits a second, much smaller seam: `DecisionModel` (`name` + `decide()`), for typed judgments (yes/no, choice, score) that come back as probabilities rather than prose. `JevDecisionModel` in `packages/providers` implements it against TypeSafe's Jev. It is used two ways:

- **As agent tools** (`tools-decision`): the model calls `classify_items`, `check_claims`, `rank_candidates` or `score_items` when it would otherwise label, verify or sift a list in its own tokens.
- **As a runtime decision layer** (`decision-layer.ts`, opt-in): once per turn, before the first LLM request, one decision call chooses which tool schemas to send (every schema is otherwise re-sent on every step) and whether a cheaper `lightLlm` will do. The choice is appended to the session log as `turn/decision` before it is acted on, and any failure, timeout or unsure answer falls back to all tools and the default model.

```
User task ──▶ AgentLoop ──▶ decideTurn ──▶ DecisionModel (Jev)        ~100s of ms, one call
                 │              │
                 │              └─ turn/decision {tools, llm} ──▶ SessionLog
                 ▼
             LlmAdapter (default or light) ◀── only the kept tool schemas
```

Whether it saves money is measured, not assumed: every reply logs the provider's token usage (`assistant/message.usage`), and every decision logs its own (`turn/decision.usage`).

It never knows whether the backend is OpenAI, Gemini, Claude, Grok, DeepSeek, OpenRouter, Ollama, LM Studio, or a custom endpoint. Switching providers is a config change:

```yaml
provider: openrouter
model: some-model
```

### 3. Agent profiles

A profile is a named bundle of {model, enabled tools}, applied over `.env`. This is how OpenAgent supports very different use cases (a read-only research agent vs. a coding agent with a shell vs. a personal assistant) without needing separate codebases. Profiles deliberately carry no permission policy: they are meant to be shared, and approval goes through `ToolRegistry.decide` alone. They load with `--profile` in the CLI and are managed in the web UI's Profiles view. See `docs/agent-design.md`.

### 4. Security is not a layer on top

Tool execution passes through the permission/approval system before running, not after. Every `ToolDefinition` declares a `permissionLevel`, and `ToolRegistry.decide` (`packages/agent/src/tools.ts`) gates every call, asks the person through an approval handler (the terminal prompt or the web UI), and keeps an audit log of each decision. Sandboxing lives with the tools that need it: the shell tools run under bubblewrap or Docker, the file and git tools are confined to one workspace and file policy, and the browser gets a throwaway profile. `packages/security` holds the OS-keychain secret store. See `docs/security-model.md`.

## Repository structure

Status markers: ✅ implemented, 🚧 design/stub only (a README with no source yet).

```
apps/
  web/         ✅ Web UI (`open-agent web`): chat, history, approvals, live steps, memory, profiles, settings, live browser view
  cli/         ✅ Command-line interface (Ink-based TUI)
packages/
  context/     ✅ Plugin/service kernel (contexts, plugins, events) the rest of the runtime is built on
  agent/       ✅ Agent loop, conversation/task state, cancellation, retries, logging
  providers/   ✅ Provider abstraction + implementations (generic OpenAI-compatible, Anthropic, Gemini, multi-provider fallback)
  tools-mcp/   ✅ Generic MCP stdio client + ToolDefinition adapter (used by any MCP-backed tool package)
  registry/    ✅ Static index of known MCP tools
  tools-browser/ ✅ Browser tools, backed by browser-use's MCP server via tools-mcp
  tools-computer/ ✅ Computer-use tools, backed by @ui-tars/sdk + @ui-tars/operator-nut-js (see docs/agent-design.md)
  tools-terminal/ ✅ run_command + background process management (start/list/read/stop), workspace-rooted, timed out and killed by process group, sandboxed via bubblewrap or Docker with a read-only filesystem and no network by default
  tools-http/  ✅ http_request: direct calls to APIs with no MCP server, behind a host allowlist and secret placeholders
  tools-decision/ ✅ classify_items/check_claims/rank_candidates/score_items: typed judgments with calibrated probabilities from a DecisionModel (Jev today), for the small calls not worth an LLM round-trip
  tools-search/ ✅ web_search: a search API (Brave, Tavily) behind a SearchProvider seam, usable without the browser tools
  tools-files/ ✅ read_file/write_file/list_directory/search_files over one workspace, with a file policy that keeps secrets (.env, keys) unreadable and unsearchable; per-session workspaces provisioned and cleaned up
  tools-git/ ✅ git_status/git_diff/git_log (safe) and git_commit/git_branch (ask, plan previews) over the file tools' workspace and policy; hooks, fsmonitor and diff drivers off, refuses repository-set filter drivers and signing programs
  tools/       🚧 Placeholder (README only); the built tools are the tools-* packages
  automation/  ✅ Task scheduler: durable schedule, pluggable trigger kinds, fires tasks into a runner seam (Milestone 8)
  memory/      ✅ Long-term/semantic memory, user preferences (SupermemoryProvider, Mem0Provider, in-memory)
  security/    ✅ Secret stores (OS keychain); the permission system lives in agent/
docs/          Architecture, agent design, security model
tests/         🚧 Placeholder; integration tests live with their packages as *.integration.test.ts
examples/      Example agent profiles and scripts
docker/        🚧 Placeholder; the shell sandbox's Docker backend needs no files here
```

## Language choice

TypeScript-first across `apps/` and `packages/` for a unified type system between the runtime, tool interfaces, and web UI. Individual tools (e.g. computer-use/vision helpers) may shell out to Python where the ecosystem is stronger, but the agent core and tool contracts are TypeScript. A desktop shell, if there is one, is another host around the same core; see [desktop-shell.md](desktop-shell.md) for why that would be Tauri wrapping the web UI, and why not yet.

## Kernel: plugins, services, events

`packages/context` implements the mechanism the rules above rely on, inspired by the plugin kernel ([Cordis](https://github.com/cordiverse/cordis)) underneath [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — re-derived at a much smaller scale, not ported:

- A **context** is a repository of services keyed by name (`ctx.get('tools')`, `ctx.get('llm')`, `ctx.get('sessions')`). A service claims one key; other code finds it by key instead of importing a concrete implementation — this is what makes providers and tools swappable from configuration rather than code.
- A **plugin** registers services/listeners on a context, and can declare `inject: [...]` dependencies so it only activates once those services exist, regardless of mount order.
- **Events** have five dispatch modes — `emit` (fire-and-forget), `waterfall` (around-middleware that can rewrite or short-circuit a decision), `parallel`, `serial`, `bail` (first defined result wins) — used for interception and policy (e.g. a tool's `ask`/`dangerous` approval gate).
- **Registrations are reversible effects**: whatever a plugin registers unwinds when it's disposed.

`packages/agent` builds the turn/step agent loop, the session event log, and the tool registry as plugins on top of this kernel (`ctx.sessions`, `ctx.tools`, `ctx.llm`, `ctx.agentLoop`). A **turn** is one full run of a task; a **step** is one model request plus the tools it calls. The session log is append-only and is the only source the model-visible message history is projected from — this is also what conversation/task state, replay, and audit logging derive from. See `packages/agent/README.md` for the concrete API.
