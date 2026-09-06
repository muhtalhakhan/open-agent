# @open-agent/tools-files

Filesystem tools, all of them confined to one workspace root: `read_file`, `write_file`, `list_directory` and `search_files`. They share `workspace.ts` for path confinement, `file-policy.ts` for which files inside the root are off-limits, and `filters.ts` for what a walk skips by default.

## Workspaces

A workspace is the directory a session may touch, plus the file policy for what inside it is off-limits. Mounting the tools against one is what keeps them from disagreeing — configuring each separately made it possible to give `read_file` one root and `write_file` another, or to deny a path for reads and forget to deny it for search.

```ts
import { createSessionWorkspace, mountFileTools, openWorkspace } from '@open-agent/tools-files'

// Work in a directory the user already has:
const workspace = await openWorkspace({ root: process.cwd(), policy: { deny: ['internal/**'] } })

// Or provision a throwaway one per session, so two concurrent agents
// cannot see or clobber each other's files:
const scratch = await createSessionWorkspace({ base: '/var/lib/open-agent' })

const dispose = mountFileTools(tools, workspace)
// ... later
dispose()
await workspace.dispose() // deletes a provisioned directory; never one you opened
```

`dispose()` on an opened workspace deliberately does nothing — deleting the user's checkout on exit would be an outrage. A provisioned one is removed unless you pass `cleanup: false` to inspect the aftermath. Re-entering a session by its id finds the existing directory rather than failing, so a run can be resumed.

**A workspace is not a security boundary.** It is a directory and a set of path checks; `run_command` can still walk out of it. Isolation that survives a hostile command is #86's sandbox.

## Usage

```ts
import { ToolRegistry } from '@open-agent/agent'
import { listDirectoryTool, readFileTool, searchFilesTool, writeFileTool } from '@open-agent/tools-files'

const root = process.cwd()
const policy = { deny: ['internal/**'] } // on top of the built-in secret list
const tools = new ToolRegistry()
tools.register(readFileTool({ root, policy }))
tools.register(listDirectoryTool({ root, policy }))
tools.register(searchFilesTool({ root, policy }))
tools.register(writeFileTool({ root, policy }))
```

In the CLI, set `FILES_TOOL=1` (and optionally `FILES_ROOT`, which defaults to the directory you launched it from) — see `.env.example`.

## `read_file`

`{ path, offset?, limit? }` → the file's text, `cat -n` style, so the model can refer to a line by number.

```
 1	import path from 'node:path'
 2	import fs from 'node:fs/promises'
```

## `list_directory`

`{ path?, recursive?, all? }` → directories first with a trailing slash, then files with their size in bytes.

```
src/
README.md	1284
```

Walks breadth-first, so a listing cut off at the ceiling is a complete shallow picture rather than the first 500 files down one arbitrary branch. Dot-files and vendor/build directories (`node_modules`, `.git`, `dist`, `target`, …) are hidden unless `all` is set.

## `search_files`

`{ query?, glob?, path?, regex?, case_sensitive?, all? }` → `path:line: matching-text`, like `grep -n`.

```
src/agent-loop.ts:42: const result = await this.tools.execute(call, context)
```

`query` is literal text unless `regex` is set, and case-insensitive unless `case_sensitive` is. `glob` narrows which files are searched and matches against the path relative to the search base, so `*.ts` means "a .ts file anywhere under it". Give a `glob` with no `query` to just list the files it matches. The glob subset is the familiar one — `*` within a segment, a doubled `*` across segments, `?` for one character — not a full glob implementation.

## `write_file`

`{ path, content, append?, create_only? }` → `created notes.txt (5 bytes)`.

Replaces the whole file unless `append` is set, creates parent directories as needed, and refuses to overwrite when `create_only` is set. A replace is atomic: the content goes to a sibling temp file which is then renamed over the target, so a crash or a cancelled task leaves the original intact rather than a half-written file.

## File policy

The root answers "which directory", which is the wrong granularity for what people actually worry about: a `.env` sitting in the middle of the project you want the agent to work on. `docs/security-model.md` promises the model never sees raw API keys, and a root-only check cannot deliver that when the keys are in a file inside the root.

So secrets are excluded by default — `.env` and `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.jks`, `id_rsa` and friends, `.ssh/**`, `.aws/credentials`, `.kube/config`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.git/config`, `credentials.json`, `secrets.y*ml`. `.env.example` and its siblings are carved back out: a template of variable _names_ with the values blank is checked in precisely so people can read it.

A denied path is refused for reads and writes, **and** left out of listings and search results. That last part is the point rather than a nicety — a search that printed the matching line from `.env` would leak the secret exactly as thoroughly as reading the file. Listings say how many entries were hidden without naming them, which tells the model to stop looking without telling it what to ask for.

```ts
{
  deny: ['internal/**'],   // added to the built-ins
  allow: ['.env.local'],   // wins over a deny, including a default one
  readOnly: true,          // refuse every write, whatever the path
  noDefaults: true,        // drop the built-in lists entirely
}
```

Patterns match the root-relative path _and_ the basename, so `.env` covers `packages/api/.env` without a leading `**`. Matching is case-insensitive, since macOS and Windows will serve `.ENV` for a file the policy knows as `.env`.

**It binds these four tools, not the machine.** `run_command` can `cat .env`, because a shell command is opaque to a path check. That is what the approval prompt on every command is for, and ultimately #86's sandbox.

## Permission levels

`read_file`, `list_directory` and `search_files` are `safe`. The capability is granted once, at configuration time, by handing the tool a root; after that a read inside that root changes nothing, and prompting on every one would only train the user to approve without looking. Which files inside the root are still off-limits is the file policy above, applied before anything is opened.

`write_file` is `ask`. It destroys whatever was there before, and the blast radius is a file the user cares about. The root bounds _where_ that can happen; the approval prompt is what makes each one a decision.

## Guard rails

Shared by all four tools:

- **Workspace root** — every `path` resolves against the root and must land inside it. A `..` traversal is rejected lexically, and an existing target is then resolved through `realpath` and re-checked, so a symlink inside the root cannot be used to read outside it. The root's own symlinks are resolved first, so a root under a symlinked `/tmp` still works.
- **Byte ceiling** (`maxBytes`, default 64000) and **line ceiling** (`maxLines`, default 2000) — a long file comes back a page at a time, with a note giving the `offset` to continue from, so one read can't evict the conversation.
- **Line clipping** — a single line over 2000 characters (a minified bundle) is clipped rather than allowed to spend the whole budget.
- **Text only** — a NUL byte in the first 4KB means the file is reported as binary instead of pasted in.
- **Streaming** — the file is read as a stream and stopped at the ceiling, so paging to line 50000 of a huge file doesn't load the whole thing. The caller's `AbortSignal` is honoured mid-read.

Per tool:

- **`list_directory`** — 500 entries per call, then a note giving the way to narrow it.
- **`search_files`** — 100 matches and 5000 files opened per call, files over 2MB skipped as bundles or data dumps, binary files skipped by the same NUL sniff `read_file` uses, and matching lines over 400 characters clipped. The `AbortSignal` is checked per directory and per file.
- **`write_file`** — 1MB of content per call, rejected before anything touches the disk; a write is refused outright if the task was already cancelled.
