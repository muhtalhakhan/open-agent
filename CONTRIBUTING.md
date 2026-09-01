# Contributing to OpenAgent

Thanks for considering a contribution. OpenAgent is built in public, and you don't need to implement the whole system to help.

## Ways to contribute

- **Code**: pick up an open issue under a milestone (see the [milestones](../../milestones) page).
- **Tools**: add a new tool under `packages/tools/` following the tool SDK (once available).
- **Providers**: add a new LLM provider under `packages/providers/`.
- **Docs**: improve `docs/architecture.md`, `docs/agent-design.md`, `docs/security-model.md`, or write guides.
- **Testing**: add unit/integration tests, or file reproducible bug reports.
- **Security research**: see [SECURITY.md](SECURITY.md) for how to report vulnerabilities responsibly.
- **Design/UI**: improvements to `apps/web`.

## Ground rules

1. **Every capability is a tool.** Don't add browser/computer/filesystem-specific logic to the agent core — implement it as a tool behind the tool registry interface.
2. **Providers are interchangeable.** New providers must implement the shared `generate() / stream() / tool_call() / vision()` interface in `packages/providers` — the agent must not special-case a provider.
3. **Security first.** Any tool that can take a real-world action (send an email, run a shell command, write a file outside the workspace, etc.) must go through the permission/approval system in `packages/security`. Don't bypass it for convenience.
4. **Small, focused PRs.** Prefer several small PRs over one large one. Link the issue you're addressing.
5. **Tests for behavior changes.** New tools and providers need at least basic unit tests.

## Getting started

1. Fork the repo and clone your fork.
2. Check `docs/architecture.md` for how a request flows through the system.
3. Pick an issue labeled `good-first-issue` or `help-wanted`, or open one describing what you'd like to work on before starting significant work.
4. Open a PR referencing the issue.

## Commit / PR style

- Use clear, descriptive commit messages (what changed and why).
- Keep PRs scoped to one milestone/issue where possible.
- Fill out the PR template — it asks what changed, how it was tested, and whether it touches security-sensitive code paths.

## Code of conduct

Be respectful, assume good faith, and keep discussion focused on the work. Harassment or abusive behavior toward other contributors will not be tolerated.
