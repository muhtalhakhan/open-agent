import fs from 'node:fs/promises'
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '@open-agent/agent'
import { makePatch } from './diff.js'
import { FilePolicyError, checkAccess, type FilePolicy } from './file-policy.js'
import { WorkspaceError, resolvePathInWorkspace } from './workspace.js'
import { writeAtomic } from './write-file.js'

/** Larger than any source file worth editing by string match; a bigger one is a job for write_file. */
const DEFAULT_MAX_BYTES = 2_000_000

export interface EditFileToolOptions {
  /** Absolute path the tool may edit under. Every argument resolves inside it. */
  root: string
  /** Which files inside the root are off-limits, and whether writes are allowed at all. */
  policy?: FilePolicy
  /** Size of file the tool will edit (default 2000000 bytes). */
  maxBytes?: number
}

type EditFileArgs = {
  path: string
  old_text: string
  new_text: string
  replace_all?: boolean
}

const SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File to edit, relative to the workspace root.' },
    old_text: {
      type: 'string',
      description: 'The exact text to replace, whitespace and indentation included. Read the file first to copy it.',
    },
    new_text: { type: 'string', description: 'What to put in its place. Empty to delete it.' },
    replace_all: {
      type: 'boolean',
      description: 'Replace every occurrence instead of requiring exactly one (default false).',
    },
  },
  required: ['path', 'old_text', 'new_text'],
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

function countOf(haystack: string, needle: string): number {
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++
  return count
}

interface Planned {
  file: string
  before: string
  after: string
  replaced: number
}

/**
 * The edit worked out in full without writing: shared by `execute` and the
 * plan-mode preview, so the diff a person approves is the edit that runs.
 */
async function planEdit(
  options: EditFileToolOptions,
  args: EditFileArgs,
  signal: AbortSignal,
): Promise<Planned | ToolResult> {
  if (typeof args.old_text !== 'string' || args.old_text === '') return fail('old_text is required and cannot be empty')
  if (typeof args.new_text !== 'string') return fail('new_text is required and must be a string')
  if (args.old_text === args.new_text) return fail('old_text and new_text are the same; there is nothing to change')

  let file: string
  try {
    const resolved = await resolvePathInWorkspace(options.root, args.path)
    checkAccess(resolved.relative, 'write', options.policy)
    file = resolved.absolute
  } catch (err) {
    if (err instanceof FilePolicyError || err instanceof WorkspaceError) return fail(err.message)
    return fail(err instanceof Error ? err.message : String(err))
  }

  const shown = args.path
  try {
    const stats = await fs.stat(file)
    if (!stats.isFile()) return fail(`"${shown}" is not a regular file`)
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    if (stats.size > maxBytes) return fail(`"${shown}" is ${stats.size} bytes, over the ${maxBytes}-byte edit limit`)
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('edit was cancelled')

    const before = await fs.readFile(file, 'utf8')
    const found = countOf(before, args.old_text)
    if (found === 0) {
      return fail(`old_text was not found in "${shown}". Read the file again and copy the text exactly.`)
    }
    // One match is the only unambiguous one: replacing the first of several
    // is a guess about which the model meant, and a wrong guess is a silent
    // edit somewhere else in the file.
    if (found > 1 && args.replace_all !== true) {
      return fail(
        `old_text occurs ${found} times in "${shown}". Include more of the surrounding text to pick one, ` +
          'or set replace_all to change them all.',
      )
    }
    const after =
      args.replace_all === true
        ? before.split(args.old_text).join(args.new_text)
        : before.replace(args.old_text, () => args.new_text)
    return { file, before, after, replaced: found }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return fail(`no such file: "${shown}"`)
    if (code === 'EACCES' || code === 'EPERM') return fail(`permission denied editing "${shown}"`)
    return fail(err instanceof Error ? err.message : String(err))
  }
}

const isResult = (value: Planned | ToolResult): value is ToolResult => 'ok' in value

/**
 * Change part of a file in the workspace by exact string match.
 *
 * `ask`, like `write_file`, and bound by the same root and policy. It exists
 * because a whole-file rewrite to change one line costs the model the whole
 * file in output and risks it dropping something it was not looking at; an
 * edit that names the text it replaces cannot.
 */
export function editFileTool(options: EditFileToolOptions): ToolDefinition<EditFileArgs> {
  const run = async (args: EditFileArgs, context: ToolExecutionContext): Promise<ToolResult> => {
    const planned = await planEdit(options, args, context.signal)
    if (isResult(planned)) return planned
    try {
      await writeAtomic(planned.file, planned.after)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    const what = planned.replaced === 1 ? '1 occurrence' : `${planned.replaced} occurrences`
    return { ok: true, content: `edited ${args.path}: replaced ${what}` }
  }

  return {
    name: 'edit_file',
    description:
      'Edit a text file in the workspace by replacing an exact piece of text. old_text must match exactly once ' +
      '(include surrounding lines to make it unique) unless replace_all is set. Prefer this to write_file for changes ' +
      'to an existing file.',
    schema: SCHEMA,
    permissionLevel: 'ask',
    execute: run,
    async plan(args, context) {
      const planned = await planEdit(options, args, context.signal)
      if (isResult(planned)) return planned
      return { ok: true, content: makePatch(args.path, planned.before, planned.after) }
    },
  }
}
