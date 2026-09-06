import fs from 'node:fs/promises'
import path from 'node:path'
import type { ToolDefinition, ToolResult } from '@open-agent/agent'
import { isDenied, type FilePolicy } from './file-policy.js'
import { shouldSkip } from './filters.js'
import { WorkspaceError, resolvePathInWorkspace, toPosix } from './workspace.js'

/** Enough to see a large source directory whole, small enough not to evict the conversation. */
const DEFAULT_MAX_ENTRIES = 500

export interface ListDirectoryToolOptions {
  /** Absolute path the tool may list under. Every argument resolves inside it. */
  root: string
  /** Which files inside the root are off-limits. Denied entries are left out of the listing. */
  policy?: FilePolicy
  /** Entries returned in one call (default 500). */
  maxEntries?: number
}

type ListDirectoryArgs = {
  path?: string
  recursive?: boolean
  all?: boolean
}

const SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Directory to list, relative to the workspace root (default ".").' },
    recursive: { type: 'boolean', description: 'Descend into subdirectories (default false).' },
    all: {
      type: 'boolean',
      description: 'Include dot-files and build/vendor directories such as node_modules and .git (default false).',
    },
  },
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

interface Entry {
  /** Path relative to the listed directory, so output stays readable when recursing. */
  relative: string
  kind: 'dir' | 'file' | 'other'
  size: number
}

/**
 * `dirent.isFile()` and friends describe the link itself, not its target, so a
 * symlink is reported as what it points at — that is what the model is going
 * to act on. A dangling one is reported as `other` rather than failing the
 * whole listing over one broken entry.
 */
async function describe(absolute: string): Promise<{ kind: Entry['kind']; size: number }> {
  try {
    const stats = await fs.stat(absolute)
    if (stats.isDirectory()) return { kind: 'dir', size: 0 }
    if (stats.isFile()) return { kind: 'file', size: stats.size }
    return { kind: 'other', size: 0 }
  } catch {
    return { kind: 'other', size: 0 }
  }
}

/**
 * Walks breadth-first so a shallow listing is complete before the budget goes
 * on depth: truncated at 500 entries, "every file in src/ plus the first level
 * below it" is a far more useful answer than "the first 500 files down one
 * arbitrary branch".
 */
async function walk(
  base: string,
  baseRelative: string,
  recursive: boolean,
  all: boolean,
  maxEntries: number,
  policy: FilePolicy | undefined,
  signal: AbortSignal,
): Promise<{ entries: Entry[]; truncated: boolean; hidden: number }> {
  const entries: Entry[] = []
  const queue: string[] = ['']
  let truncated = false
  let hidden = 0

  while (queue.length > 0) {
    const relativeDir = queue.shift()!
    const dirents = await fs.readdir(path.join(base, relativeDir), { withFileTypes: true })
    dirents.sort((a, b) => a.name.localeCompare(b.name))

    for (const dirent of dirents) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('listing was cancelled')
      if (shouldSkip(dirent.name, all)) continue

      const relative = relativeDir ? path.join(relativeDir, dirent.name) : dirent.name
      // Counted, not named. Saying "one entry is hidden" tells the model to
      // stop looking without telling it what to go asking for.
      if (isDenied(toPosix(baseRelative ? path.join(baseRelative, relative) : relative), policy)) {
        hidden += 1
        continue
      }
      if (entries.length >= maxEntries) {
        truncated = true
        return { entries, truncated, hidden }
      }

      const { kind, size } = await describe(path.join(base, relative))
      entries.push({ relative, kind, size })
      if (recursive && kind === 'dir') queue.push(relative)
    }
  }

  return { entries, truncated, hidden }
}

/** Directories first, then files, each alphabetically — the order `ls` trained everyone to expect. */
function render(entries: Entry[]): string {
  const sorted = [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : b.kind === 'dir' ? 1 : 0
    return a.relative.localeCompare(b.relative)
  })
  return sorted
    .map((entry) => (entry.kind === 'dir' ? `${entry.relative}/` : `${entry.relative}\t${entry.size}`))
    .join('\n')
}

/**
 * List a directory in the workspace.
 *
 * `safe`, for the same reason `read_file` is: the capability was granted once
 * by handing the tool a root, and a listing inside it changes nothing.
 */
export function listDirectoryTool(options: ListDirectoryToolOptions): ToolDefinition<ListDirectoryArgs> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES

  return {
    name: 'list_directory',
    description:
      'List the contents of a directory in the workspace. Directories are shown with a trailing slash, ' +
      'files with their size in bytes. Dot-files and build directories such as node_modules are hidden unless all=true.',
    schema: SCHEMA,
    permissionLevel: 'safe',
    async execute(args, context) {
      const requested = args.path === undefined || args.path === '' ? '.' : args.path
      let directory: string
      let directoryRelative: string
      try {
        const resolved = await resolvePathInWorkspace(options.root, requested)
        directory = resolved.absolute
        directoryRelative = resolved.relative
      } catch (err) {
        if (err instanceof WorkspaceError) return fail(err.message)
        return fail(err instanceof Error ? err.message : String(err))
      }

      // Errors name the path the model actually wrote, not the resolved one.
      const shown = requested
      try {
        const stats = await fs.stat(directory)
        if (!stats.isDirectory()) return fail(`"${shown}" is not a directory`)

        const { entries, truncated, hidden } = await walk(
          directory,
          directoryRelative,
          args.recursive === true,
          args.all === true,
          maxEntries,
          options.policy,
          context.signal,
        )

        const notes: string[] = []
        if (truncated)
          notes.push(`[stopped at ${maxEntries} entries; narrow the path or drop recursive to see the rest]`)
        if (hidden > 0) notes.push(`[${hidden} ${hidden === 1 ? 'entry is' : 'entries are'} hidden by the file policy]`)

        if (entries.length === 0) {
          const empty = `${shown} is empty`
          return { ok: true, content: notes.length ? `${empty}\n\n${notes.join('\n')}` : empty }
        }

        const body = render(entries)
        return { ok: true, content: notes.length ? `${body}\n\n${notes.join('\n')}` : body }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return fail(`no such directory: "${shown}"`)
        if (code === 'EACCES' || code === 'EPERM') return fail(`permission denied listing "${shown}"`)
        if (err instanceof WorkspaceError) return fail(err.message)
        return fail(err instanceof Error ? err.message : String(err))
      }
    },
  }
}
