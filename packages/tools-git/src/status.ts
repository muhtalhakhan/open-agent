import type { ToolDefinition } from '@open-agent/agent'
import { clip, failure, git, openRepository, type GitToolOptions } from './git.js'

const MAX_BYTES = 16_000

/**
 * The repository's state before touching it: the branch and how it stands
 * against its upstream, and every staged, changed and untracked file.
 *
 * `safe`: it reads, and what it shows is file names, which `list_directory`
 * shows already.
 */
export function gitStatusTool(options: GitToolOptions): ToolDefinition<Record<string, never>> {
  return {
    name: 'git_status',
    description:
      'Show the git branch, how it compares with its upstream, the local branches, and every staged, ' +
      'modified and untracked file, in `git status --short` form (XY path: X is the staged state, Y the unstaged).',
    schema: { type: 'object', properties: {} },
    permissionLevel: 'safe',
    async execute(_args, context) {
      try {
        const root = await openRepository(options.root, context.signal)
        const status = await git(root, ['status', '--short', '--branch', '--untracked-files=normal'], context.signal)
        const branches = await git(root, ['branch', '--format=%(HEAD) %(refname:short)'], context.signal)
        const listed = branches
          .split('\n')
          .filter(Boolean)
          .map((line) => (line.startsWith('*') ? `${line.slice(2)} (current)` : line.slice(2)))
        const clean = status.trim().split('\n').length === 1 ? '\nNothing to commit: the working tree is clean.' : ''
        const body = `${status.trimEnd()}${clean}\n\nLocal branches: ${listed.join(', ') || '(none yet)'}`
        return { ok: true, content: clip(body, MAX_BYTES, 'Use git_diff with a path to look at part of it.') }
      } catch (err) {
        return failure(err)
      }
    },
  }
}
