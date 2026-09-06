import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { ToolDefinition, ToolResult } from '@open-agent/agent'
import { WorkspaceError, resolveInWorkspace } from './workspace.js'

/** Enough for a whole source file, small enough not to evict the conversation. */
const DEFAULT_MAX_BYTES = 64_000
const DEFAULT_MAX_LINES = 2_000
/** A minified bundle is one enormous line; clip it rather than spend the budget on it. */
const MAX_LINE_CHARS = 2_000
const SNIFF_BYTES = 4_096

export interface ReadFileToolOptions {
  /** Absolute path the tool may read under. Every argument resolves inside it. */
  root: string
  /** Content bytes returned before the read is cut off (default 64000). */
  maxBytes?: number
  /** Lines returned in one call (default 2000). */
  maxLines?: number
}

type ReadFileArgs = {
  path: string
  offset?: number
  limit?: number
}

const SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File to read, relative to the workspace root.' },
    offset: { type: 'number', description: 'First line to return, 1-based (default 1).' },
    limit: { type: 'number', description: 'How many lines to return (default 2000).' },
  },
  required: ['path'],
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

function positiveInt(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new WorkspaceError(`${name} must be a positive integer`)
  }
  return value
}

/** A NUL byte in the first few KB is the cheap, conventional "this is not text" test. */
async function looksBinary(file: string): Promise<boolean> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

interface Slice {
  lines: string[]
  /** Number of the last line the reader consumed, skipped ones included. */
  lastLineSeen: number
  hasMore: boolean
  byteCapped: boolean
  clipped: boolean
}

/**
 * Stream the file and keep only the requested window. Streaming rather than
 * reading the whole file matters for the argument this tool exists to serve:
 * paging through a file far larger than the byte ceiling.
 */
async function readSlice(
  file: string,
  offset: number,
  limit: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Slice> {
  const stream = createReadStream(file, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const lines: string[] = []
  let lastLineSeen = 0
  let bytes = 0
  let hasMore = false
  let byteCapped = false
  let clipped = false

  try {
    for await (const raw of reader) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('read was cancelled')
      lastLineSeen += 1
      if (lastLineSeen < offset) continue
      if (lines.length >= limit) {
        hasMore = true
        break
      }
      const line = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)} …[line truncated]` : raw
      if (line !== raw) clipped = true
      bytes += Buffer.byteLength(line) + 1
      if (bytes > maxBytes) {
        byteCapped = true
        hasMore = true
        break
      }
      lines.push(line)
    }
  } finally {
    reader.close()
    stream.destroy()
  }

  return { lines, lastLineSeen, hasMore, byteCapped, clipped }
}

/** `cat -n` layout: the model needs stable line numbers to talk about a file. */
function number(lines: string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length
  return lines.map((line, index) => `${String(firstLine + index).padStart(width)}\t${line}`).join('\n')
}

/**
 * Read a text file from the workspace, with line numbers so the model can
 * refer to what it read.
 *
 * `safe`: the capability is granted once, at configuration time, by handing
 * the tool a root — after that a read inside that root changes nothing and
 * prompting on every one would train the user to approve blindly. What the
 * root should exclude (a `.env`, a key file) is per-file policy and belongs
 * with the file-permission work, not here. See docs/security-model.md.
 */
export function readFileTool(options: ReadFileToolOptions): ToolDefinition<ReadFileArgs> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES

  return {
    name: 'read_file',
    description:
      'Read a text file from the workspace and return its contents with line numbers. ' +
      'Long files come back a page at a time — use offset and limit to read the rest.',
    schema: SCHEMA,
    permissionLevel: 'safe',
    async execute(args, context) {
      let file: string
      let offset: number
      let limit: number
      try {
        file = await resolveInWorkspace(options.root, args.path)
        offset = positiveInt(args.offset, 1, 'offset')
        limit = Math.min(positiveInt(args.limit, maxLines, 'limit'), maxLines)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }

      // Errors name the path the model actually wrote, not the resolved one.
      const shown = args.path
      try {
        const stats = await fs.stat(file)
        if (stats.isDirectory()) return fail(`"${shown}" is a directory, not a file`)
        if (!stats.isFile()) return fail(`"${shown}" is not a regular file`)
        if (await looksBinary(file)) {
          return fail(`"${shown}" looks like a binary file (${stats.size} bytes); read_file only handles text`)
        }

        const slice = await readSlice(file, offset, limit, maxBytes, context.signal)
        if (slice.lastLineSeen === 0) return { ok: true, content: `${shown} is empty` }
        if (slice.lines.length === 0) {
          return fail(`offset ${offset} is past the end of "${shown}" (${slice.lastLineSeen} lines)`)
        }

        const last = offset + slice.lines.length - 1
        const notes: string[] = []
        if (slice.hasMore) {
          notes.push(
            `[showing lines ${offset}-${last}${slice.byteCapped ? `; stopped at the ${maxBytes}-byte ceiling` : ''}` +
              `. Read on with offset=${last + 1}.]`,
          )
        }
        if (slice.clipped) notes.push(`[lines longer than ${MAX_LINE_CHARS} characters were clipped]`)

        const body = number(slice.lines, offset)
        return { ok: true, content: notes.length ? `${body}\n\n${notes.join('\n')}` : body }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return fail(`no such file: "${shown}"`)
        if (code === 'EACCES' || code === 'EPERM') return fail(`permission denied reading "${shown}"`)
        return fail(err instanceof Error ? err.message : String(err))
      }
    },
  }
}
