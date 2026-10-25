import type { ToolDefinition, ToolExecutionContext, ToolResult } from '@open-agent/agent'
import { FilePolicyError, resolvePathInWorkspace } from '@open-agent/tools-files'
import { GitError, byPolicy, failure, git, nulSeparated, openRepository, runGit, type GitToolOptions } from './git.js'

const MAX_MESSAGE_CHARS = 10_000

type GitCommitArgs = {
  message: string
  paths?: string[]
  all?: boolean
}

const SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'The commit message: a short subject line, then a blank line and a body.' },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Files to stage before committing, relative to the workspace root, new files included.',
    },
    all: {
      type: 'boolean',
      description: 'Stage every change to tracked files first, like `git commit -a` (default false).',
    },
  },
  required: ['message'],
}

interface Prepared {
  root: string
  message: string
  /** What `git add` is given: named paths, or `-u` for every tracked change. */
  stage: string[]
  /** Every file the commit will contain, as far as can be known before staging. */
  files: string[]
}

/**
 * Works out what the commit would contain and refuses it before anything
 * changes. A file the policy denies would put a secret into history, where
 * it outlives the file — so it is refused whether the call names it, `all`
 * would sweep it up, or the person had staged it already.
 */
async function prepare(options: GitToolOptions, args: GitCommitArgs, signal: AbortSignal): Promise<Prepared> {
  if (options.policy?.readOnly === true) throw new FilePolicyError('the workspace is read-only')
  const message = typeof args.message === 'string' ? args.message.trim() : ''
  if (!message) throw new GitError('message is required')
  if (message.length > MAX_MESSAGE_CHARS) throw new GitError(`message is longer than ${MAX_MESSAGE_CHARS} characters`)
  if (args.paths !== undefined && !Array.isArray(args.paths)) throw new GitError('paths must be a list of file paths')
  if (args.paths?.length && args.all === true) throw new GitError('give paths or all, not both')

  const root = await openRepository(options.root, signal)
  const staged = nulSeparated(await git(root, ['diff', '--cached', '--no-renames', '--name-only', '-z'], signal))
  let toStage: string[] = []
  let stage: string[] = []
  if (args.paths?.length) {
    for (const requested of args.paths) toStage.push((await resolvePathInWorkspace(root, requested)).relative)
    stage = ['--', ...toStage]
  } else if (args.all === true) {
    toStage = nulSeparated(await git(root, ['diff', '--no-renames', '--name-only', '-z'], signal))
    stage = ['-u']
  }

  const files = [...new Set([...staged, ...toStage])].sort()
  const { denied } = byPolicy(files, options.policy)
  if (denied.length > 0) {
    throw new FilePolicyError(
      `refusing to commit files the workspace file policy excludes: ${denied.join(', ')}` +
        (denied.some((file) => staged.includes(file)) ? '. Unstage them first (they were already staged).' : ''),
    )
  }
  if (files.length === 0)
    throw new GitError('nothing to commit: stage files with paths or all, or change something first')
  return { root, message, stage, files }
}

async function currentBranch(root: string, signal: AbortSignal): Promise<string> {
  const branch = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)
  return branch.code === 0 ? branch.stdout.trim() : 'a detached HEAD'
}

/**
 * Commits in the workspace's repository, under the person's own git
 * identity.
 *
 * `ask`: a commit is the agent's work entering history under the person's
 * name. It runs with hooks off and `--no-verify`, since a hook is a program
 * from the repository (see `HARDENING` in git.ts), so a check the project
 * wires to pre-commit has to be run as a command instead.
 */
export function gitCommitTool(options: GitToolOptions): ToolDefinition<GitCommitArgs> {
  const run = async (args: GitCommitArgs, context: ToolExecutionContext): Promise<ToolResult> => {
    try {
      const { root, message, stage } = await prepare(options, args, context.signal)
      if (stage.length > 0) await git(root, ['add', ...stage], context.signal)
      // Staging may have found nothing to add: the check that matters is what is staged now.
      if ((await runGit(root, ['diff', '--cached', '--quiet'], context.signal)).code === 0) {
        return failure(new GitError('nothing to commit: the files named have no changes'))
      }
      await git(root, ['commit', '--no-verify', '--quiet', '--cleanup=strip', '-m', message], context.signal)
      const summary = await git(root, ['show', '--stat', '--no-ext-diff', '--format=%h %s', 'HEAD'], context.signal)
      return { ok: true, content: `Committed on ${await currentBranch(root, context.signal)}:\n${summary.trimEnd()}` }
    } catch (err) {
      return failure(err)
    }
  }

  return {
    name: 'git_commit',
    description:
      'Commit to the git repository. Stages the given paths (or every tracked change with all=true) first, ' +
      'then commits everything staged. Git hooks do not run. Refuses files the workspace policy excludes.',
    schema: SCHEMA,
    permissionLevel: 'ask',
    execute: run,
    async plan(args, context) {
      try {
        const { root, message, files } = await prepare(options, args, context.signal)
        const branch = await currentBranch(root, context.signal)
        const list = files.map((file) => `  ${file}`).join('\n')
        return { ok: true, content: `Commit on ${branch}:\n\n${message}\n\nFiles:\n${list}` }
      } catch (err) {
        return failure(err)
      }
    },
  }
}
