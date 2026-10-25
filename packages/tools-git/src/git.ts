import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import type { ToolResult } from '@open-agent/agent'
import { FilePolicyError, WorkspaceError, isDenied, type FilePolicy } from '@open-agent/tools-files'

/** Plenty for any status or a diff worth reading; the tools clip what they return well below it. */
const MAX_BUFFER = 16 * 1024 * 1024
const TIMEOUT_MS = 30_000

/**
 * Prepended to every command. Git runs on the host, outside the shell
 * sandbox, and several of its features run programs the repository names:
 * hooks, an fsmonitor, external diff and textconv drivers. The shell tool can
 * write into `.git/` from inside its sandbox, so a host-side git that obeyed
 * those would be a way out of it. Command-line `-c` outranks every config
 * file, so these hold whatever the repository says.
 */
const HARDENING = [
  '--no-pager',
  '-c',
  `core.hooksPath=${os.devNull}`,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'color.ui=false',
  '-c',
  'core.quotePath=false',
]

/**
 * Settings a repository's own config can use to run a program that no flag
 * above switches off: filter drivers run on status and add, and a signing
 * program on commit. Set globally they are the person's choice (git-lfs puts
 * its filter there); set in the repository, anything that could write
 * `.git/config` could have chosen them.
 */
const RUNS_A_PROGRAM = /^(filter\.[^\n]+\.(clean|smudge|process)|gpg\.program|gpg\.[^.\n]+\.program)$/i

/** Scopes written inside the repository, where the agent's shell may reach. */
const REPOSITORY_SCOPES = new Set(['local', 'worktree'])

export class GitError extends Error {
  override name = 'GitError'
}

export interface GitResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * Only what git needs: where the person's global config is (for their name
 * and email), how to find programs, and nothing that could redirect it —
 * `GIT_DIR`, `GIT_EXTERNAL_DIFF` and friends from the parent environment are
 * dropped.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP']
  const identity = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
  const env: NodeJS.ProcessEnv = {}
  for (const name of [...keep, ...identity]) if (process.env[name] !== undefined) env[name] = process.env[name]
  return {
    ...env,
    // English, so a failure reads the same in every transcript.
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    // Every command that could open an editor is given its text; this is the
    // backstop that makes one exit at once instead of waiting on nobody.
    GIT_EDITOR: 'true',
    GIT_OPTIONAL_LOCKS: '0',
  }
}

/** Runs git without a shell. A non-zero exit is returned, not thrown: some callers expect one. */
export function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...HARDENING, ...args],
      { cwd, env: gitEnv(), maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS, signal, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') reject(new GitError('git is not installed'))
          else reject(err)
          return
        }
        resolve({ stdout, stderr, code: err ? (err.code as unknown as number) : 0 })
      },
    )
  })
}

/** Like `runGit`, but a failure is a `GitError` carrying git's own message. */
export async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await runGit(cwd, args, signal)
  if (result.code !== 0) {
    throw new GitError(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed (exit ${result.code})`)
  }
  return result.stdout
}

export interface GitToolOptions {
  /** The workspace root, which must be the top level of a repository. */
  root: string
  /** The file tools' policy: a file `read_file` may not read is not diffed, staged or committed either. */
  policy?: FilePolicy
}

/**
 * Checks before every call, since the repository can change between them:
 * the workspace is a repository's top level, and its config names no program
 * for git to run.
 *
 * The top-level rule is what keeps the tools inside the workspace. Run from a
 * subdirectory, git still reports and commits the whole repository, and the
 * capability the person granted was this directory, not its parents.
 */
export async function openRepository(root: string, signal?: AbortSignal): Promise<string> {
  const realRoot = await fs.realpath(root)
  const result = await runGit(realRoot, ['rev-parse', '--show-toplevel'], signal)
  if (result.code !== 0) throw new GitError(`the workspace (${realRoot}) is not a git repository`)
  const top = await fs.realpath(result.stdout.trim())
  if (top !== realRoot) {
    throw new GitError(
      `the workspace (${realRoot}) is inside the repository at ${top}, not its top level. ` +
        `Git tools act on the whole repository, so they need the workspace root set to ${top}.`,
    )
  }

  // `-z` with `--show-scope` gives the scope and then `key\nvalue`, as separate fields.
  const fields = (await git(realRoot, ['config', '--list', '--show-scope', '--includes', '-z'], signal)).split('\0')
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const key = fields[i + 1].split('\n', 1)[0]
    if (REPOSITORY_SCOPES.has(fields[i]) && RUNS_A_PROGRAM.test(key)) {
      throw new GitError(
        `the repository's own config sets ${key}, which makes git run a program. ` +
          `Git tools refuse to run with it; move it to your global config if you meant it.`,
      )
    }
  }
  return realRoot
}

/** Splits `-z` output, which ends with a NUL, into its entries. */
export function nulSeparated(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '')
}

/** Splits paths into those the file policy lets the agent read and those it does not. */
export function byPolicy(paths: string[], policy: FilePolicy | undefined): { allowed: string[]; denied: string[] } {
  const allowed: string[] = []
  const denied: string[] = []
  for (const file of paths) (isDenied(file, policy) ? denied : allowed).push(file)
  return { allowed, denied }
}

/** A ref or branch name the model wrote, refused if git could read it as an option. */
export function checkRefArgument(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new GitError(`${name} is required`)
  const trimmed = value.trim()
  if (trimmed.startsWith('-')) throw new GitError(`${name} cannot start with "-"`)
  if (/[\0\n]/.test(trimmed)) throw new GitError(`${name} cannot contain a line break`)
  return trimmed
}

/** Output clipped to what a model should read in one result, with a note saying so. */
export function clip(text: string, maxBytes: number, hint: string): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const cut = Buffer.from(text).subarray(0, maxBytes).toString('utf8').replace(/�$/, '')
  return `${cut}\n\n[cut at ${maxBytes} bytes. ${hint}]`
}

export function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

/** The errors a git tool reports as its result rather than throwing. */
export function failure(err: unknown): ToolResult {
  if (err instanceof GitError || err instanceof FilePolicyError || err instanceof WorkspaceError)
    return fail(err.message)
  return fail(err instanceof Error ? err.message : String(err))
}
