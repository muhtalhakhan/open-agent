import type { ToolDefinition } from '@open-agent/agent'
import { resolvePathInWorkspace } from '@open-agent/tools-files'
import { checkRefArgument, failure, git, openRepository, runGit, type GitToolOptions } from './git.js'

const DEFAULT_COUNT = 20
const MAX_COUNT = 100

type GitLogArgs = {
  count?: number
  ref?: string
  path?: string
}

const SCHEMA = {
  type: 'object',
  properties: {
    count: { type: 'number', description: `How many commits to show, newest first (default ${DEFAULT_COUNT}).` },
    ref: { type: 'string', description: 'Start from this branch, tag or commit instead of the current one.' },
    path: { type: 'string', description: 'Only commits that touched this file or directory.' },
  },
}

/**
 * Recent history, one commit a line: enough to see what has been done and
 * how this repository words its commit messages before writing one.
 * Messages and names only — no file contents — so `safe`.
 */
export function gitLogTool(options: GitToolOptions): ToolDefinition<GitLogArgs> {
  return {
    name: 'git_log',
    description: 'List recent git commits, newest first: short hash, date, author and subject.',
    schema: SCHEMA,
    permissionLevel: 'safe',
    async execute(args, context) {
      try {
        const root = await openRepository(options.root, context.signal)
        const count = args.count ?? DEFAULT_COUNT
        if (!Number.isInteger(count) || count < 1) return failure(new Error('count must be a positive integer'))
        const start = args.ref === undefined ? [] : [checkRefArgument(args.ref, 'ref')]
        const scope = args.path === undefined ? [] : [(await resolvePathInWorkspace(root, args.path)).relative || '.']
        // A repository with no commits yet has no HEAD to log from.
        if (start.length === 0 && (await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) {
          return { ok: true, content: 'No commits yet.' }
        }
        const log = await git(
          root,
          [
            'log',
            `--max-count=${Math.min(count, MAX_COUNT)}`,
            '--date=short',
            '--format=%h %ad %an: %s',
            '--end-of-options',
            ...start,
            '--',
            ...scope,
          ],
          context.signal,
        )
        return { ok: true, content: log.trimEnd() || 'No commits match.' }
      } catch (err) {
        return failure(err)
      }
    },
  }
}
