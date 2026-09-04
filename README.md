# OpenAgent

[![CI](https://github.com/muhtalhakhan/open-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/muhtalhakhan/open-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Milestones](https://img.shields.io/badge/roadmap-milestones-blueviolet)](../../milestones)

An open-source, self-hosted AI agent that can use your computer, browser, files, tools, and APIs.

OpenAgent is a provider-agnostic AI agent platform designed to give users control over their own AI agents. Bring your own API key. Choose your model. Run locally or remotely.

## Why

AI shouldn't be locked to one provider. Today, powerful computer-using agents are increasingly available as closed platforms tied to a single vendor's models and infrastructure. OpenAgent aims to provide an open alternative where users control the model, infrastructure, tools, data, and permissions.

## What can it do?

|     | Capability                                    | Status                                                                                                                                                                         |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🌐  | Browse the web                                | ✅ Built — `tools-browser`, backed by browser-use's MCP server (14 tools: navigate, click, type, scroll, extract content, tabs, ...)                                           |
| 🖥️  | Control a computer                            | ✅ Built — `tools-computer`, backed by `@ui-tars/sdk` (screenshot → prediction → mouse/keyboard loop)                                                                          |
| 🔧  | Use external tools and MCP servers            | ✅ Built — generic MCP stdio client in `tools-mcp`, used by both browser and computer tools                                                                                    |
| 🧠  | Remember information across tasks             | ✅ Built — `memory` package, pluggable across Supermemory / mem0 / in-memory                                                                                                   |
| 🔐  | Ask for permission before sensitive actions   | ✅ Built — every tool declares a `safe` / `ask` / `dangerous` permission level, enforced by the agent loop                                                                     |
| 🧠  | Use any model                                 | ✅ Built — Anthropic and Gemini adapters, any OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio, vLLM, ...), and `ProviderFallbackAdapter` for multi-provider failover |
| 💻  | Run code and terminal commands                | 🚧 Planned — see Milestone 5 (Files + Terminal)                                                                                                                                |
| ⏰  | Run scheduled tasks                           | 🚧 Planned — see Milestone 8 (Automation)                                                                                                                                      |
| 🤖  | Operate autonomously with configurable limits | 🚧 Planned — see Milestone 9 (Security) / Milestone 10 (Cloud)                                                                                                                 |

A CLI is available today (`npm run cli`); the web UI described below is still a design doc, not code.

See the [milestones](../../milestones) for the full roadmap and what's currently in progress.

## Provider-agnostic by design

OpenAgent is not tied to a single AI provider. Any OpenAI-compatible endpoint works today via `OpenAiCompatibleProvider` — that already covers OpenAI, OpenRouter, Ollama, LM Studio, and self-hosted vLLM. Providers whose API shape diverges get a dedicated adapter:

- Anthropic — ✅ `AnthropicProvider`
- Google Gemini — ✅ `GeminiProvider`
- xAI — 🚧 planned
- DeepSeek — 🚧 planned

Configure several at once with `ProviderFallbackAdapter`: it tries adapters in order and falls through to the next on 401/403/429, so a rate-limited or misconfigured provider doesn't take the agent down. See `packages/providers/src/fallback-provider.ts`.

The agent runtime doesn't care which model powers it — a provider is just a config value.

## Run it yourself

OpenAgent is designed for:

- Local computers
- Docker
- Self-hosted servers
- VPS environments
- Cloud infrastructure

Your API keys, files, browser profiles, and agent data can remain under your control.

## Project status

OpenAgent has a working agent runtime, tool calling, browser automation, computer control, and pluggable memory. Filesystem/terminal tools, scheduling, a dedicated security package, and the web UI are still ahead — see the capability table above and the [milestones](../../milestones) for what's done vs. planned.

See [docs/architecture.md](docs/architecture.md), [docs/agent-design.md](docs/agent-design.md), and [docs/security-model.md](docs/security-model.md) for the design docs.

## Quickstart

The fastest way to actually run OpenAgent rather than just read about it:

```bash
git clone https://github.com/muhtalhakhan/open-agent
cd open-agent
npm install
cp .env.example .env   # fill in OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL — any OpenAI-compatible endpoint works
npm run cli
```

That starts an interactive terminal session against the real agent loop, tool registry, and (optionally) browser/memory tools — see [apps/cli/README.md](apps/cli/README.md) for what it wires up and how. For a single non-interactive run of the original "search the web, summarize, save a report" demo, see [examples/research-and-report.ts](examples/research-and-report.ts) (`npm run example:research`).

## Repository layout

```
apps/
  web/            Web UI (design only — no implementation yet)
  cli/            Command-line interface (Ink-based TUI)
packages/
  context/         Plugin/service kernel the rest of the runtime is built on
  agent/           Agent loop, session log, tool registry
  providers/       LLM provider abstraction (OpenAI-compatible, Anthropic, Gemini, fallback)
  tools-browser/   Browser tools, via browser-use's MCP server
  tools-computer/  Computer-use tools, via @ui-tars/sdk
  tools-mcp/       Generic MCP stdio client used by the tool packages above
  tools/           Remaining built-in tools (filesystem, shell — planned)
  memory/          Long-term/semantic memory (Supermemory, mem0, in-memory)
  security/        Permission system, approvals, sandboxing (design only — no implementation yet)
docs/             Architecture and design docs
tests/            Cross-package/integration tests
examples/         Example agent profiles and scripts
docker/           Container definitions
```

## Contributing

OpenAgent is intended to be built in public. You don't need to implement the entire system to contribute. Ideas, documentation, testing, integrations, tools, security research, UI improvements, and bug reports are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

An autonomous agent can potentially access files, execute commands, browse authenticated websites, and interact with external services. Security is a core part of OpenAgent, not an optional feature. Never give an agent more permissions than it needs. See [SECURITY.md](SECURITY.md).

## License

OpenAgent is open source under the [MIT License](LICENSE).
