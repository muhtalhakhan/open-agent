# Working in this repo

Conventions for OpenAgent. Loaded automatically into the agent's system prompt
(see "Project conventions" in the README), so keep it short and specific —
every line is paid for on every request.

## Layout

TypeScript monorepo on npm workspaces. `apps/cli` (the terminal app) and
`apps/web`; `packages/agent` (loop, session log, tool registry),
`packages/providers` (LLM adapters), `packages/memory`, `packages/context`
(a plugin kernel — _not_ prompt context), and the `tools-*` packages.

`packages/tools` and `packages/security` are README-only placeholders. Nothing
is implemented in either, despite what CONTRIBUTING.md says — the permission
and approval system actually lives in `packages/agent/src/tools.ts`.

## Invariants worth knowing before editing

- **The session log is the source of truth.** Nothing reaches the model unless
  it was appended to `SessionLog` first. Don't inject anything at request time
  that isn't in the log, or the transcript stops explaining what the model saw.
- **Everything above `safe` is denied by default.** `ToolRegistry.decide` gates
  every call; `dangerous` additionally requires `enableDangerous(name)`. Don't
  route around it for convenience.
- **`LlmAdapter` is `name` + `generate()`.** That is the whole interface —
  CONTRIBUTING.md's mention of `stream()`/`tool_call()`/`vision()` is aspirational.
  The agent core must never special-case a provider by name.
- **The user's message is what the user typed.** Background context (recalled
  memories, project conventions) belongs in the system message via
  `RunOptions.context` or `systemPrompt`, never spliced into the user's text.
- **In the CLI, `src/index.ts` is the only file that touches real
  stdin/stdout/env.** Everything else takes injected IO so it can be tested.
  In print mode stdout carries the answer alone — diagnostics go to stderr.
- **Don't put an `await` between `createInterface()` and the first prompt** in
  `apps/cli/src/index.ts`. Yielding to I/O there lets readline consume and
  discard piped input, and `echo task | open-agent` silently does nothing.
  `cli.integration.test.ts` pins this.

## Style

- ESM throughout: relative imports carry the `.js` suffix (`./session.js`) even
  from `.ts` sources. Named exports; default exports are used only in the Ink UI.
- `import type { … }` for type-only imports — ESLint enforces it.
- Prettier owns formatting: no semicolons, single quotes, 120 columns, trailing
  commas. Don't hand-format; run `npm run format`.
- Comments explain **why**, not what. Match the surrounding density: the
  existing prose comments carry design rationale and the reason a non-obvious
  choice was made. A comment restating the code is worse than none.

## Tests

- Colocated with sources as `src/*.test.ts`, Vitest, run with `npm test`.
- Network-facing code takes an injected fake (`fetchFn`, a scripted
  `LlmAdapter`, a fake IO object) — the suite must pass with no API keys and no
  network.
- `*.integration.test.ts` spawns the real CLI and is excluded from `npm test`;
  it runs under `npm run test:integration`. CI runs both.
- When a test would have caught a bug you're fixing, check that it actually
  fails without the fix before calling it done.

## Before finishing

Run all five, in this order — CI runs the same and `format:check` is the one
most often forgotten:

```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:integration
```

`main` is protected: branch, PR, green CI. Never commit or push to `main`
directly.
