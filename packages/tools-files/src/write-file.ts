import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ToolDefinition, ToolResult } from '@open-agent/agent'
import { FilePolicyError, checkAccess, type FilePolicy } from './file-policy.js'
import { WorkspaceError, resolvePathInWorkspace } from './workspace.js'

/**
 * A model writing more than this in one call is nearly always a runaway
 * generation rather than a file anyone wanted. The cap is on the argument, so
 * it costs nothing to enforce and stops the write before it touches the disk.
 */
const DEFAULT_MAX_BYTES = 1_000_000

export interface WriteFileToolOptions {
  /** Absolute path the tool may write under. Every argument resolves inside it. */
  root: string
  /** Which files inside the root are off-limits, and whether writes are allowed at all. */
  policy?: FilePolicy
  /** Content bytes accepted in one call (default 1000000). */
  maxBytes?: number
}

type WriteFileArgs = {
  path: string
  content: string
  append?: boolean
  create_only?: boolean
}

const SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File to write, relative to the workspace root.' },
    content: { type: 'string', description: 'The complete new contents of the file.' },
    append: { type: 'boolean', description: 'Append to the file instead of replacing it (default false).' },
    create_only: {
      type: 'boolean',
      description: 'Fail instead of replacing the file if it already exists (default false).',
    },
  },
  required: ['path', 'content'],
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

/**
 * Replace the file in one atomic step: write a sibling temp file, then rename
 * over the target. A crash or a cancelled task partway through then leaves the
 * original intact rather than a half-written file — which for a tool whose
 * whole job is replacing the user's source files is the difference between a
 * failed call and lost work.
 *
 * The temp file is a sibling rather than in the system temp directory so the
 * rename stays within one filesystem, where it is atomic.
 */
async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.writeFile(temporary, content, 'utf8')
    await fs.rename(temporary, file)
  } catch (err) {
    await fs.rm(temporary, { force: true })
    throw err
  }
}

/**
 * Write a text file in the workspace.
 *
 * `ask`: unlike a read, this destroys whatever was there before, and the
 * blast radius is a file the user cares about. The workspace root bounds
 * *where* it can happen; the approval prompt is what makes each one a
 * decision. See docs/security-model.md.
 */
export function writeFileTool(options: WriteFileToolOptions): ToolDefinition<WriteFileArgs> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  return {
    name: 'write_file',
    description:
      'Write a text file in the workspace, creating parent directories as needed. ' +
      'Replaces the whole file unless append is set; pass create_only to refuse to overwrite an existing file.',
    schema: SCHEMA,
    permissionLevel: 'ask',
    async execute(args, context) {
      if (typeof args.content !== 'string') return fail('content is required and must be a string')
      const bytes = Buffer.byteLength(args.content)
      if (bytes > maxBytes) {
        return fail(`content is ${bytes} bytes, over the ${maxBytes}-byte limit for one write`)
      }

      let file: string
      try {
        const resolved = await resolvePathInWorkspace(options.root, args.path)
        checkAccess(resolved.relative, 'write', options.policy)
        file = resolved.absolute
      } catch (err) {
        if (err instanceof FilePolicyError || err instanceof WorkspaceError) return fail(err.message)
        return fail(err instanceof Error ? err.message : String(err))
      }

      // Errors name the path the model actually wrote, not the resolved one.
      const shown = args.path
      try {
        const existing = await fs.stat(file).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return null
          throw err
        })
        if (existing?.isDirectory()) return fail(`"${shown}" is a directory, not a file`)
        if (existing && !existing.isFile()) return fail(`"${shown}" is not a regular file`)
        if (existing && args.create_only === true) return fail(`"${shown}" already exists`)

        // Checked here rather than only at the top: resolving the path and
        // stat-ing it are the slow parts, and a task cancelled during them
        // should not still land a write.
        if (context.signal.aborted) {
          throw context.signal.reason instanceof Error ? context.signal.reason : new Error('write was cancelled')
        }

        await fs.mkdir(path.dirname(file), { recursive: true })
        if (args.append === true) {
          await fs.appendFile(file, args.content, 'utf8')
        } else {
          await writeAtomic(file, args.content)
        }

        const verb = args.append === true ? 'appended to' : existing ? 'replaced' : 'created'
        return { ok: true, content: `${verb} ${shown} (${bytes} bytes)` }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EACCES' || code === 'EPERM') return fail(`permission denied writing "${shown}"`)
        if (code === 'ENOTDIR') return fail(`a path component of "${shown}" is not a directory`)
        if (err instanceof WorkspaceError) return fail(err.message)
        return fail(err instanceof Error ? err.message : String(err))
      }
    },
  }
}
