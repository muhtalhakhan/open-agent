# @open-agent/cli

An interactive terminal REPL for the agent runtime — the easiest way to actually run OpenAgent and see the pieces work together, rather than reading about them.

## Run it

```bash
cp .env.example .env   # from the repo root, then fill in at least the OPENAI_* vars
npm install
npm run cli
```

(`npm run cli` runs `apps/cli`'s `start` script, which is `tsx src/index.ts` — no build step needed.)

## TUI vs plain mode

When stdin/stdout are a real terminal, the CLI renders an [Ink](https://github.com/vadimdemedes/ink)-based TUI: a scrollable transcript (rendered once per entry via Ink's `<Static>`, so your terminal's own scrollback still works) with a fixed input line pinned below it, plus a transient "thinking…" status while a task is running. Piped input/output, CI, or anything else without a TTY on both ends falls back automatically to the plain `readline`-based REPL from before — set `CLI_NO_TUI=1` to force that fallback yourself. `:exit`, Ctrl+C (cancel the running task, or quit if idle), and Ctrl+D (quit) behave the same in both modes.

## Headless / print mode

`open-agent -p "<task>"` runs one task and exits instead of opening a session — no TUI, no readline, no prompts. The task can also arrive on stdin (`echo "<task>" | open-agent -p`). Only the final answer is written to stdout; the conventions notice, approval decisions and failures go to stderr, so the answer can be redirected on its own. Exit status is `0` completed, `1` failed, `130` cancelled.

Because nothing can answer an approval prompt, `ask`-level tool calls are denied by default and the refusal is logged to stderr; `--yes` approves them. `dangerous` tools remain unreachable either way — `ToolRegistry` gates those on `enableDangerous` before any handler runs.

Both modes share one task path (`task.ts`): recall memories, run the loop, store the answer. `repl.ts` and `headless.ts` differ only in the IO wrapped around it.

## What it wires up

- **Provider**: `OpenAiCompatibleProvider` from `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL` — point it at OpenAI, OpenRouter, Ollama, or LM Studio.
- **Browser tools**: mounted when `BROWSER_USE=1` (needs Python + `browser-use` installed — see `packages/tools-browser/README.md`).
- **Memory**: `SupermemoryProvider` if `SUPERMEMORY_API_KEY` is set, else `Mem0Provider` if `MEM0_API_KEY` is set, else the dependency-free `InMemoryMemoryProvider`. Each turn recalls relevant memories and prepends them as context, then stores the answer as a new memory — a real use of the seam, not just mounted-and-unused.
- **Approval**: `ask`/`dangerous`-level tool calls prompt you in the terminal (`y`/`N`) before running, per `docs/security-model.md`.
- **Cancellation**: Ctrl+C aborts whichever task is currently running (via `AbortSignal`, same mechanism `AgentLoop` already supports); press it again with nothing running to exit.

## Source layout

`src/index.ts` is the only part that touches real stdin/stdout/env — everything else is written to be testable with fake IO:

- `args.ts` — pure `argv -> CliArgs` parsing via `node:util`'s `parseArgs` (`args.test.ts`)
- `config.ts` — pure `env -> CliConfig` parsing (`config.test.ts`)
- `task.ts` — one task end to end, shared by both modes
- `headless.ts` — print mode: stream split and exit codes (`headless.test.ts`)
- `approval.ts` — the y/N prompt, given an injectable `ask()` function (`approval.test.ts`)
- `repl.ts` — the read-task-print loop, given fake `ReplIO` and a real `AgentLoop` with a scripted `LlmAdapter` (`repl.test.ts`)
- `tui/` — the Ink TUI: `App.tsx` (the component), `tui-io.ts` (bridges Ink to the `ReplIO`/approval-`ask` shapes the rest of the CLI is written against, tested without rendering anything in `tui-io.test.ts`), `mount.tsx` (wires the two together)
