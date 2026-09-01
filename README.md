# OpenAgent

An open-source, self-hosted AI agent that can use your computer, browser, files, tools, and APIs.

OpenAgent is a provider-agnostic AI agent platform designed to give users control over their own AI agents. Bring your own API key. Choose your model. Run locally or remotely.

## Why

AI shouldn't be locked to one provider. Today, powerful computer-using agents are increasingly available as closed platforms tied to a single vendor's models and infrastructure. OpenAgent aims to provide an open alternative where users control the model, infrastructure, tools, data, and permissions.

## What can it do?

OpenAgent is designed to eventually let an AI agent:

- 🌐 Browse the web
- 🖥️ Control a computer
- 💻 Run code and terminal commands
- 📁 Read and create files
- 🧠 Remember information across tasks
- 🔧 Use external tools and MCP servers
- ⏰ Run scheduled tasks
- 🤖 Operate autonomously with configurable limits
- 🔐 Ask for permission before sensitive actions
- 🧠 Use any model

## Provider-agnostic by design

OpenAgent is not tied to a single AI provider. Planned providers include:

- OpenAI
- Google Gemini
- Anthropic
- xAI
- OpenRouter
- DeepSeek
- Ollama
- LM Studio
- Custom OpenAI-compatible endpoints

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

OpenAgent is in early development. The initial goal is to build a reliable agent runtime with:

- Multiple LLM providers
- Tool calling
- Browser automation
- Computer control
- Filesystem and terminal access
- Persistent memory
- Permission and security controls

See [docs/architecture.md](docs/architecture.md), [docs/agent-design.md](docs/agent-design.md), and [docs/security-model.md](docs/security-model.md) for the design docs, and the [milestones](../../milestones) for the roadmap.

## Repository layout

```
apps/
  web/         Web UI
  cli/         Command-line interface
packages/
  agent/       Agent runtime (loop, state, tool registry)
  providers/   LLM provider abstraction and implementations
  tools/       Built-in tools (browser, files, shell, computer use)
  memory/      Conversation/task/long-term memory
  security/    Permissions, approvals, sandboxing
docs/          Architecture and design docs
tests/         Cross-package/integration tests
examples/      Example agent profiles and scripts
docker/        Container definitions
```

## Contributing

OpenAgent is intended to be built in public. You don't need to implement the entire system to contribute. Ideas, documentation, testing, integrations, tools, security research, UI improvements, and bug reports are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

An autonomous agent can potentially access files, execute commands, browse authenticated websites, and interact with external services. Security is a core part of OpenAgent, not an optional feature. Never give an agent more permissions than it needs. See [SECURITY.md](SECURITY.md).

## License

OpenAgent is open source under the [MIT License](LICENSE).
