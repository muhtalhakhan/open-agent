import fs from 'node:fs/promises'
import path from 'node:path'
import type { ToolDefinition, ToolResult } from '@open-agent/agent'
import { globToRegExp, shouldSkip } from './filters.js'
import { WorkspaceError, resolveInWorkspace } from './workspace.js'

/** Matches returned in one call. Past this the model should narrow the query, not read more. */
const DEFAULT_MAX_MATCHES = 100
/** Files opened in one call, so a search of a huge tree ends rather than crawling it all. */
const MAX_FILES_SCANNED = 5_000
/** A file larger than this is a bundle, a lockfile or a data dump — not something to grep for prose. */
const MAX_FILE_BYTES = 2_000_000
/** A minified bundle is one enormous line; clip the match rather than paste the file. */
const MAX_LINE_CHARS = 400
const SNIFF_BYTES = 4_096

export interface SearchFilesToolOptions {
  /** Absolute path the tool may search under. Every argument resolves inside it. */
  root: string
  /** Matches returned in one call (default 100). */
  maxMatches?: number
}

type SearchFilesArgs = {
  query?: string
  glob?: string
  path?: string
  regex?: boolean
  case_sensitive?: boolean
  all?: boolean
}

const SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Text to find inside files. Omit it to list the files matching glob instead.',
    },
    glob: {
      type: 'string',
      description: 'Only search files whose path matches this glob, e.g. "*.ts" or "src/**/*.test.ts".',
    },
    path: { type: 'string', description: 'Directory to search under, relative to the workspace root (default ".").' },
    regex: { type: 'boolean', description: 'Treat query as a regular expression (default false, literal text).' },
    case_sensitive: { type: 'boolean', description: 'Match case exactly (default false).' },
    all: { type: 'boolean', description: 'Search dot-files and build directories too (default false).' },
  },
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} …[clipped]` : line
}

/**
 * Collects candidate file paths breadth-first, relative to the search base.
 *
 * The whole candidate list is gathered before any file is opened so that
 * `MAX_FILES_SCANNED` bounds the work honestly: a tree that overflows it is
 * reported as truncated rather than silently searched in part.
 */
async function candidates(
  base: string,
  glob: RegExp | undefined,
  all: boolean,
  signal: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  const queue: string[] = ['']

  while (queue.length > 0) {
    const relativeDir = queue.shift()!
    let dirents
    try {
      dirents = await fs.readdir(path.join(base, relativeDir), { withFileTypes: true })
    } catch {
      // A directory that vanished or cannot be read mid-walk is skipped rather
      // than failing a search that may already have found what was wanted.
      continue
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name))

    for (const dirent of dirents) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('search was cancelled')
      if (shouldSkip(dirent.name, all)) continue

      const relative = relativeDir ? path.join(relativeDir, dirent.name) : dirent.name
      if (dirent.isDirectory()) {
        queue.push(relative)
      } else if (dirent.isFile()) {
        // Matched against the path relative to the search base, so `*.ts`
        // means "a .ts file anywhere under it" rather than only at the top.
        if (glob && !glob.test(relative) && !glob.test(dirent.name)) continue
        if (files.length >= MAX_FILES_SCANNED) return { files, truncated: true }
        files.push(relative)
      }
    }
  }

  return { files, truncated: false }
}

interface Match {
  file: string
  line: number
  text: string
}

/** A NUL byte in the first few KB is the cheap, conventional "this is not text" test. */
function looksBinary(contents: Buffer): boolean {
  return contents.subarray(0, SNIFF_BYTES).includes(0)
}

async function scan(
  base: string,
  files: string[],
  pattern: RegExp,
  maxMatches: number,
  signal: AbortSignal,
): Promise<{ matches: Match[]; truncated: boolean }> {
  const matches: Match[] = []

  for (const file of files) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('search was cancelled')

    const absolute = path.join(base, file)
    let stats
    try {
      stats = await fs.stat(absolute)
    } catch {
      continue
    }
    if (stats.size > MAX_FILE_BYTES) continue

    let contents: Buffer
    try {
      contents = await fs.readFile(absolute)
    } catch {
      continue // unreadable file: skip it rather than fail the whole search
    }
    if (looksBinary(contents)) continue

    const lines = contents.toString('utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      // `lastIndex` persists on a global regex between calls, so it is reset
      // rather than letting one line's match start the next line's search
      // partway through.
      pattern.lastIndex = 0
      if (!pattern.test(lines[index])) continue
      if (matches.length >= maxMatches) return { matches, truncated: true }
      matches.push({ file, line: index + 1, text: clip(lines[index]) })
    }
  }

  return { matches, truncated: false }
}

/**
 * Find text or files in the workspace.
 *
 * `safe`, for the same reason `read_file` is: the root was granted once at
 * configuration time, and searching inside it changes nothing.
 */
export function searchFilesTool(options: SearchFilesToolOptions): ToolDefinition<SearchFilesArgs> {
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES

  return {
    name: 'search_files',
    description:
      'Search the workspace for text inside files, like grep. Returns path:line: matching-text. ' +
      'Pass glob to narrow which files are searched, or omit query to just list the files matching glob.',
    schema: SCHEMA,
    permissionLevel: 'safe',
    async execute(args, context) {
      const requested = args.path === undefined || args.path === '' ? '.' : args.path
      const caseSensitive = args.case_sensitive === true

      if (args.query === undefined && args.glob === undefined) {
        return fail('give a query to search for, a glob to match filenames, or both')
      }

      let base: string
      let glob: RegExp | undefined
      let pattern: RegExp | undefined
      try {
        base = await resolveInWorkspace(options.root, requested)
        if (args.glob !== undefined) {
          if (typeof args.glob !== 'string' || args.glob === '')
            throw new WorkspaceError('glob must be a non-empty string')
          glob = globToRegExp(args.glob, caseSensitive)
        }
        if (args.query !== undefined) {
          if (typeof args.query !== 'string' || args.query === '') {
            throw new WorkspaceError('query must be a non-empty string')
          }
          const source = args.regex === true ? args.query : escapeRegExp(args.query)
          pattern = new RegExp(source, caseSensitive ? 'g' : 'gi')
        }
      } catch (err) {
        // An invalid regex is the model's mistake to fix, so it is reported as
        // a tool failure with the engine's own message rather than thrown.
        if (err instanceof SyntaxError) return fail(`query is not a valid regular expression: ${err.message}`)
        return fail(err instanceof Error ? err.message : String(err))
      }

      // Errors name the path the model actually wrote, not the resolved one.
      const shown = requested
      try {
        const stats = await fs.stat(base)
        if (!stats.isDirectory()) return fail(`"${shown}" is not a directory`)

        const found = await candidates(base, glob, args.all === true, context.signal)
        const notes: string[] = []
        if (found.truncated) notes.push(`[stopped after ${MAX_FILES_SCANNED} files; narrow path or glob]`)

        if (!pattern) {
          if (found.files.length === 0) return { ok: true, content: `no files match ${args.glob} under ${shown}` }
          const body = found.files.join('\n')
          return { ok: true, content: notes.length ? `${body}\n\n${notes.join('\n')}` : body }
        }

        const { matches, truncated } = await scan(base, found.files, pattern, maxMatches, context.signal)
        if (matches.length === 0) {
          return { ok: true, content: `no matches for ${JSON.stringify(args.query)} under ${shown}` }
        }
        if (truncated) notes.push(`[stopped at ${maxMatches} matches; narrow the query to see the rest]`)

        const body = matches.map((match) => `${match.file}:${match.line}: ${match.text}`).join('\n')
        return { ok: true, content: notes.length ? `${body}\n\n${notes.join('\n')}` : body }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return fail(`no such directory: "${shown}"`)
        if (code === 'EACCES' || code === 'EPERM') return fail(`permission denied searching "${shown}"`)
        if (err instanceof WorkspaceError) return fail(err.message)
        return fail(err instanceof Error ? err.message : String(err))
      }
    },
  }
}
