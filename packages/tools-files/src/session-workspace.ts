import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FilePolicy } from './file-policy.js'

/**
 * A workspace is the directory an agent session is allowed to touch, plus the
 * policy for what inside it is off-limits.
 *
 * Before this, every tool took a bare `root` string and each one was
 * configured separately — which made it possible, and easy, to hand the file
 * tools one directory and the shell another. It also left nothing owning the
 * session's lifecycle: two agents run from the same checkout shared a
 * directory and wrote over each other, and nothing cleaned up after either.
 *
 * `openWorkspace` names an existing directory you want the agent to work in.
 * `createSessionWorkspace` provisions a fresh one per session, which is what
 * makes concurrent sessions independent.
 *
 * What this is not: a security boundary. A workspace is a directory and a set
 * of path checks, and `run_command` can still walk out of it — see
 * `packages/tools-terminal`. Isolation that survives a hostile command is
 * #86's sandbox.
 */
export interface Workspace {
  /** Stable identifier for the session this workspace belongs to. */
  id: string
  /** Absolute path, symlinks resolved. Every tool path resolves inside it. */
  root: string
  /** Which files inside the root are off-limits. */
  policy: FilePolicy
  /**
   * Releases the workspace. For a provisioned one that means deleting the
   * directory; for one opened over an existing directory it does nothing,
   * because deleting the user's checkout on exit would be an outrage.
   */
  dispose(): Promise<void>
}

export interface OpenWorkspaceOptions {
  root: string
  policy?: FilePolicy
  id?: string
}

/**
 * Wraps a directory that already exists and that the caller owns. Nothing is
 * created and `dispose` deletes nothing — this is the shape for "work in my
 * checkout", which is what the CLI does by default.
 */
export async function openWorkspace(options: OpenWorkspaceOptions): Promise<Workspace> {
  const root = await fs.realpath(options.root)
  const stats = await fs.stat(root)
  if (!stats.isDirectory()) throw new Error(`workspace root "${options.root}" is not a directory`)

  return {
    id: options.id ?? `ws_${randomBytes(4).toString('hex')}`,
    root,
    policy: options.policy ?? {},
    async dispose() {
      // Deliberately nothing: we did not create this directory.
    },
  }
}

export interface CreateSessionWorkspaceOptions {
  /** Directory the session directory is created under (default: the OS temp dir). */
  base?: string
  /** Session identifier, and the directory name. Generated when omitted. */
  id?: string
  policy?: FilePolicy
  /** Delete the directory on `dispose` (default true). */
  cleanup?: boolean
}

/**
 * Provisions a fresh directory for one session, under `base`.
 *
 * The id is the directory name, so two concurrent sessions cannot land in the
 * same place, and a session's files are identifiable on disk while it runs
 * and gone after it. A caller that wants to inspect the aftermath passes
 * `cleanup: false`.
 */
export async function createSessionWorkspace(options: CreateSessionWorkspaceOptions = {}): Promise<Workspace> {
  const base = await fs.realpath(options.base ?? os.tmpdir())
  const id = options.id ?? `ws_${randomBytes(6).toString('hex')}`
  if (id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    throw new Error(`workspace id "${id}" must be a single path segment`)
  }

  const root = path.join(base, id)
  // `recursive: true` rather than failing on a collision: re-entering a
  // session by its id should find its directory, not refuse to start.
  await fs.mkdir(root, { recursive: true })

  return {
    id,
    root: await fs.realpath(root),
    policy: options.policy ?? {},
    async dispose() {
      if (options.cleanup === false) return
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
