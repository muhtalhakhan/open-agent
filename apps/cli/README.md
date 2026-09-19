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

## Rendered answers

In a terminal, answers are shown with their Markdown rendered: headings, bold and italic, `code`, links as label and URL, bullet and numbered lists, task boxes, quotes, fenced code blocks, and tables with aligned columns. The renderer (`markdown.ts`) is small and line-based, with no dependencies. Anything it doesn't recognise is printed as written, so no text is ever dropped. Rendering is skipped when stdout isn't a TTY, when `NO_COLOR` is set, or when `TERM=dumb`. Print mode never renders, because a script capturing the answer wants the Markdown source, not escape codes.

## Headless / print mode

`open-agent -p "<task>"` runs one task and exits instead of opening a session — no TUI, no readline, no prompts. The task can also arrive on stdin (`echo "<task>" | open-agent -p`). Only the final answer is written to stdout; the conventions notice, approval decisions and failures go to stderr, so the answer can be redirected on its own. Exit status is `0` completed, `1` failed, `130` cancelled.

Because nothing can answer an approval prompt, `ask`-level tool calls are denied by default and the refusal is logged to stderr; `--yes` approves them. `dangerous` tools remain unreachable either way — `ToolRegistry` gates those on `enableDangerous` before any handler runs.

Both modes share one task path (`task.ts`): recall memories, run the loop, store the answer. `repl.ts` and `headless.ts` differ only in the IO wrapped around it.

## Task history

`open-agent --history` lists the 20 most recent tasks across saved sessions: when each ran, how it ended, the prompt, the start of the answer, and the session id to pass to `--resume`. It needs no provider configured. Inside a session, `:history` shows the same, including this session's tasks, which are only written to disk when the session ends.

## Background jobs

In the interactive session, `:bg <task>` sends a task off to run while you keep working. When it finishes, its result (or error) is printed above the prompt. `:jobs` lists background jobs, `:job <id>` shows one in full, and `:cancel <id>` stops one. An id can be shortened to any unambiguous prefix. Jobs run one at a time, next to the foreground task rather than behind it, and `:exit` cancels any that are unfinished before the session is saved.

A background job cannot stop and ask you anything, because its question would appear while you might be answering a different task's. It gets print mode's policy instead: `ask`-level tool calls are denied (and the refusal is printed with a `[background]` tag) unless the session was started with `--yes`. `ToolRegistry` tells the approval handler which task is asking, and `createRoutingApprovalHandler` in `approval.ts` sends each question to the right policy. An "always allow" you gave in the foreground does not carry over either: the CLI marks background jobs with `tools.setUnattended`, and remembered approvals never cover an unattended task. Ctrl+C at an idle prompt quits the way `:exit` does, stopping background jobs and saving the session.

Built on `@open-agent/automation`'s `JobQueue` and `notifyOnFinish`. See `packages/automation/README.md`.

## What it wires up

- **Provider**: `OpenAiCompatibleProvider` from `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL` — point it at OpenAI, OpenRouter, Ollama, or LM Studio. Pointed at a vendor with its own conventional variable, that name wins: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`. Every credential also accepts a `<NAME>_FILE` variant naming a file holding the value, for Docker/Kubernetes secrets. With `SECRET_STORE=keychain`, any credential not set in the environment is read from the OS keychain instead (see `packages/security/README.md`). Each resolved value is filtered out of the agent's logs.
- **Filesystem tools**: `read_file`, `list_directory`, `search_files` and `write_file`, mounted when `FILES_TOOL=1` and all confined to `FILES_ROOT` (the launch directory unless set). Reading, listing and searching are `safe`; every write prompts. Secrets inside the root (`.env`, `*.pem`, `.ssh/**`, …) are excluded by default; `FILES_DENY`/`FILES_ALLOW` adjust that and `FILES_READONLY=1` refuses every write. See `packages/tools-files/README.md`.
- **Workspace**: the file and shell tools share one, so a command runs where the files are. `WORKSPACE_SESSION=1` provisions a throwaway directory per run (under `WORKSPACE_BASE`) and deletes it on exit, which is what keeps concurrent runs apart.
- **Shell tools**: `run_command` plus background process management (`start_process`, `list_processes`, `read_process_output`, `stop_process`), mounted when `SHELL_TOOL=1`, running under `SHELL_ROOT` (falling back to `FILES_ROOT`, then the launch directory). `ask`-level, so every command prompts, and every command runs in a sandbox (`SHELL_SANDBOX`, default `auto`: bubblewrap or Docker, read-only filesystem, no network unless `SHELL_NETWORK=1`). If no sandbox is available the shell tools are not registered at all — `SHELL_SANDBOX=none` has to be set deliberately. Anything still running is killed when the CLI exits. See `packages/tools-terminal/README.md`.
- **Browser tools**: mounted when `BROWSER_USE=1` (needs Python + `browser-use` installed — see `packages/tools-browser/README.md`).
- **Memory**: `SupermemoryProvider` if `SUPERMEMORY_API_KEY` is set, else `Mem0Provider` if `MEM0_API_KEY` is set, else the dependency-free `InMemoryMemoryProvider`. Each turn recalls relevant memories and prepends them as context, then stores the answer as a new memory — a real use of the seam, not just mounted-and-unused.
- **Approval**: `ask`/`dangerous`-level tool calls prompt you in the terminal before running, per `docs/security-model.md`. Four answers: once, for the rest of this task, always this session (confirmed a second time), or no. A remembered approval covers those exact arguments, not the whole tool, and `dangerous` calls are never remembered.
- **Cancellation**: Ctrl+C aborts whichever task is currently running (via `AbortSignal`, same mechanism `AgentLoop` already supports); press it again with nothing running to exit.

## Source layout

`src/index.ts` is the only part that touches real stdin/stdout/env — everything else is written to be testable with fake IO:

- `args.ts` — pure `argv -> CliArgs` parsing via `node:util`'s `parseArgs` (`args.test.ts`)
- `config.ts` — pure `env -> CliConfig` parsing (`config.test.ts`)
- `task.ts` — one task end to end, shared by both modes
- `markdown.ts` — Markdown to styled terminal text for answers (`markdown.test.ts`)
- `history.ts` — `--history` and `:history` formatting, merging saved sessions with the live one (`history.test.ts`)
- `background.ts` — `:bg` jobs: a job queue plus finish notifications (`background.test.ts`)
- `headless.ts` — print mode: stream split and exit codes (`headless.test.ts`)
- `approval.ts` — the y/N prompt, given an injectable `ask()` function, and the router that keeps background jobs from prompting (`approval.test.ts`, `background.test.ts`)
- `repl.ts` — the read-task-print loop, given fake `ReplIO` and a real `AgentLoop` with a scripted `LlmAdapter` (`repl.test.ts`)
- `tui/` — the Ink TUI: `App.tsx` (the component), `tui-io.ts` (bridges Ink to the `ReplIO`/approval-`ask` shapes the rest of the CLI is written against, tested without rendering anything in `tui-io.test.ts`), `mount.tsx` (wires the two together)
