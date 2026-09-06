# @open-agent/tools-files

Filesystem tools, all of them confined to one workspace root: `read_file`, `write_file`, `list_directory` and `search_files`. They share `workspace.ts` for path confinement and `filters.ts` for what a walk skips by default.

## Usage

```ts
import { ToolRegistry } from '@open-agent/agent'
import { listDirectoryTool, readFileTool, searchFilesTool, writeFileTool } from '@open-agent/tools-files'

const root = process.cwd()
const tools = new ToolRegistry()
tools.register(readFileTool({ root }))
tools.register(listDirectoryTool({ root }))
tools.register(searchFilesTool({ root }))
tools.register(writeFileTool({ root }))
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

## Permission levels

`read_file`, `list_directory` and `search_files` are `safe`. The capability is granted once, at configuration time, by handing the tool a root; after that a read inside that root changes nothing, and prompting on every one would only train the user to approve without looking. Which files inside a root should still be off-limits (a `.env`, a private key) is per-file policy — that belongs with the file-permission work (#59), not in these tools.

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
