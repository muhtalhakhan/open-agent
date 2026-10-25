import type { ToolDefinition } from '@open-agent/agent'
import { resolvePathInWorkspace } from '@open-agent/tools-files'
import {
  GitError,
  IGNORE_SUBMODULES,
  NO_DRIVERS,
  byPolicy,
  checkRefArgument,
  clip,
  failure,
  git,
  nulSeparated,
  openRepository,
  type GitToolOptions,
} from './git.js'

const MAX_BYTES = 64_000

type GitDiffArgs = {
  staged?: boolean
  ref?: string
  path?: string
  stat?: boolean
}

const SCHEMA = {
  type: 'object',
  properties: {
    staged: {
      type: 'boolean',
      description: 'Show what is staged for the next commit instead of unstaged changes (default false).',
    },
    ref: {
      type: 'string',
      description: 'Compare the working tree with this commit, branch or tag instead (e.g. "main", "HEAD~3").',
    },
    path: { type: 'string', description: 'Limit the diff to this file or directory, relative to the workspace root.' },
    stat: { type: 'boolean', description: 'Only list the changed files with line counts (default false).' },
  },
}

/**
 * The changes themselves, as a unified diff.
 *
 * `safe`, like `read_file`, and bound by the same file policy: a diff of a
 * denied file would print the very contents the policy keeps from
 * `read_file`, so those files are left out and named as left out. Files are
 * listed first and diffed by name, rather than diffed whole and filtered,
 * so a denied file's contents never leave git at all.
 */
export function gitDiffTool(options: GitToolOptions): ToolDefinition<GitDiffArgs> {
  return {
    name: 'git_diff',
    description:
      'Show changes in the git repository as a unified diff: unstaged changes by default, staged ones with ' +
      'staged=true, or the working tree against a commit with ref. Untracked files are not included; ' +
      'git_status lists them. Files the workspace policy hides (secrets like .env) are left out.',
    schema: SCHEMA,
    permissionLevel: 'safe',
    async execute(args, context) {
      try {
        const root = await openRepository(options.root, context.signal)
        const selection: string[] = []
        if (args.staged === true) selection.push('--cached')
        if (args.ref !== undefined) {
          const ref = checkRefArgument(args.ref, 'ref')
          await git(
            root,
            ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
            context.signal,
          ).catch(() => {
            throw new GitError(`"${ref}" is not a commit, branch or tag here`)
          })
          selection.push(ref)
        }
        const scope = args.path === undefined ? [] : [(await resolvePathInWorkspace(root, args.path)).relative || '.']

        const changed = nulSeparated(
          await git(
            root,
            ['diff', '--no-renames', IGNORE_SUBMODULES, '--name-only', '-z', ...selection, '--', ...scope],
            context.signal,
          ),
        )
        const { allowed, denied } = byPolicy(changed, options.policy)
        const omitted = denied.length ? `\n\n[left out by the workspace file policy: ${denied.join(', ')}]` : ''
        if (allowed.length === 0) {
          return { ok: true, content: `${changed.length === 0 ? 'No changes.' : 'No changes to show.'}${omitted}` }
        }
        const format = args.stat === true ? ['--stat'] : []
        const diff = await git(
          root,
          ['diff', '--no-renames', IGNORE_SUBMODULES, ...NO_DRIVERS, ...format, ...selection, '--', ...allowed],
          context.signal,
        )
        const hint = 'Narrow it with path, or use stat=true for an overview.'
        return { ok: true, content: `${clip(diff.trimEnd(), MAX_BYTES, hint)}${omitted}` }
      } catch (err) {
        return failure(err)
      }
    },
  }
}
