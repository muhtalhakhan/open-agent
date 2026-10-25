import type { ToolDefinition, ToolExecutionContext, ToolResult } from '@open-agent/agent'
import { FilePolicyError } from '@open-agent/tools-files'
import { GitError, checkRefArgument, failure, git, openRepository, runGit, type GitToolOptions } from './git.js'

type GitBranchArgs = {
  action: 'create' | 'switch'
  name: string
  start_point?: string
  switch?: boolean
}

const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['create', 'switch'], description: 'Create a new branch, or switch to one.' },
    name: { type: 'string', description: 'The branch name.' },
    start_point: {
      type: 'string',
      description: 'For create: the commit or branch to start from (default the current commit).',
    },
    switch: { type: 'boolean', description: 'For create: switch to the new branch as well (default true).' },
  },
  required: ['action', 'name'],
}

interface Prepared {
  root: string
  args: string[]
  /** What the call would do, for plan mode. */
  description: string
  /** What it did, once it has. */
  done: string
}

async function prepare(options: GitToolOptions, args: GitBranchArgs, signal: AbortSignal): Promise<Prepared> {
  if (options.policy?.readOnly === true) throw new FilePolicyError('the workspace is read-only')
  if (args.action !== 'create' && args.action !== 'switch') throw new GitError('action must be "create" or "switch"')
  const name = checkRefArgument(args.name, 'name')
  const root = await openRepository(options.root, signal)
  // git's own rule for what a branch may be called, rather than a copy of it.
  if ((await runGit(root, ['check-ref-format', '--branch', name], signal)).code !== 0) {
    throw new GitError(`"${name}" is not a valid branch name`)
  }
  const exists = (await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], signal)).code === 0

  if (args.action === 'switch') {
    if (!exists) throw new GitError(`there is no branch "${name}"; create it with action "create"`)
    return {
      root,
      args: ['switch', '--no-guess', name],
      description: `Switch to branch ${name}.`,
      done: `Switched to branch ${name}.`,
    }
  }
  if (exists) throw new GitError(`branch "${name}" already exists; switch to it with action "switch"`)
  const start: string[] = []
  if (args.start_point !== undefined) {
    const point = checkRefArgument(args.start_point, 'start_point')
    await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${point}^{commit}`], signal).catch(() => {
      throw new GitError(`"${point}" is not a commit, branch or tag here`)
    })
    start.push(point)
  }
  const from = start[0] ?? 'the current commit'
  return args.switch === false
    ? {
        root,
        args: ['branch', '--no-track', name, ...start],
        description: `Create branch ${name} from ${from}.`,
        done: `Created branch ${name} from ${from}.`,
      }
    : {
        root,
        args: ['switch', '--no-track', '--create', name, ...start],
        description: `Create branch ${name} from ${from} and switch to it.`,
        done: `Created branch ${name} from ${from} and switched to it.`,
      }
}

/**
 * Creates or switches branches, so the agent can keep its work apart from
 * the person's when asked to.
 *
 * `ask`: switching rewrites the working tree. Git refuses a switch that
 * would overwrite uncommitted changes, and that refusal is passed on as it
 * is rather than worked around.
 */
export function gitBranchTool(options: GitToolOptions): ToolDefinition<GitBranchArgs> {
  const run = async (args: GitBranchArgs, context: ToolExecutionContext): Promise<ToolResult> => {
    try {
      const prepared = await prepare(options, args, context.signal)
      await git(prepared.root, prepared.args, context.signal)
      return { ok: true, content: prepared.done }
    } catch (err) {
      return failure(err)
    }
  }

  return {
    name: 'git_branch',
    description:
      'Create a git branch (and switch to it, unless switch=false) or switch to an existing one. ' +
      'git_status lists the branches. A switch that would overwrite uncommitted changes is refused.',
    schema: SCHEMA,
    permissionLevel: 'ask',
    execute: run,
    async plan(args, context) {
      try {
        return { ok: true, content: (await prepare(options, args, context.signal)).description }
      } catch (err) {
        return failure(err)
      }
    },
  }
}
