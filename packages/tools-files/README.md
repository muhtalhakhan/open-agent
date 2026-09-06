# @open-agent/tools-files

Filesystem tools, all of them confined to one workspace root. Today that is `read_file`; the write, list and search tools of Milestone 5 land here alongside it and share `workspace.ts`.

## Usage

```ts
import { ToolRegistry } from '@open-agent/agent'
import { readFileTool } from '@open-agent/tools-files'

const tools = new ToolRegistry()
tools.register(readFileTool({ root: process.cwd() }))
```

In the CLI, set `FILES_TOOL=1` (and optionally `FILES_ROOT`, which defaults to the directory you launched it from) — see `.env.example`.

## `read_file`

`{ path, offset?, limit? }` → the file's text, `cat -n` style, so the model can refer to a line by number.

```
 1	import path from 'node:path'
 2	import fs from 'node:fs/promises'
```

## Permission level

`safe`. The capability is granted once, at configuration time, by handing the tool a root; after that a read inside that root changes nothing, and prompting on every one would only train the user to approve without looking. Which files inside a root should still be off-limits (a `.env`, a private key) is per-file policy — that belongs with the file-permission work, not in this tool.

## Guard rails

- **Workspace root** — every `path` resolves against the root and must land inside it. A `..` traversal is rejected lexically, and an existing target is then resolved through `realpath` and re-checked, so a symlink inside the root cannot be used to read outside it. The root's own symlinks are resolved first, so a root under a symlinked `/tmp` still works.
- **Byte ceiling** (`maxBytes`, default 64000) and **line ceiling** (`maxLines`, default 2000) — a long file comes back a page at a time, with a note giving the `offset` to continue from, so one read can't evict the conversation.
- **Line clipping** — a single line over 2000 characters (a minified bundle) is clipped rather than allowed to spend the whole budget.
- **Text only** — a NUL byte in the first 4KB means the file is reported as binary instead of pasted in.
- **Streaming** — the file is read as a stream and stopped at the ceiling, so paging to line 50000 of a huge file doesn't load the whole thing. The caller's `AbortSignal` is honoured mid-read.
