import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Filenames checked at the repo root, in precedence order. The first one
 * that exists wins outright — they are alternatives, not layers, so a
 * project that wants OpenAgent-specific instructions can keep them separate
 * from an `AGENTS.md` shared with other tools without the two being
 * silently concatenated in an order nobody chose.
 */
export const INSTRUCTION_FILENAMES = ['.openagent/instructions.md', 'AGENTS.md'] as const

/**
 * Cap on the instructions folded into the system prompt.
 *
 * These are prepended to every request for the whole session, so an
 * unbounded file is paid for on every step and crowds out the task itself.
 * 32 KiB is far more than a conventions file needs and still leaves room in
 * the smallest context window a provider in this repo targets.
 */
export const MAX_INSTRUCTIONS_BYTES = 32 * 1024

export interface ProjectInstructions {
  /** File contents, truncated if it exceeded the byte cap. */
  text: string
  /** Absolute path the instructions came from, for logging and `:context`-style output. */
  source: string
  /** Repo root the file was found under, so callers can report `source` relative to it. */
  root: string
  /** True when the file was longer than `maxBytes` and had to be cut. */
  truncated: boolean
}

export interface LoadInstructionsOptions {
  /** Directory to start the repo-root search from. Defaults to `process.cwd()`. */
  cwd?: string
  maxBytes?: number
}

/**
 * Walks up from `startDir` looking for the directory that holds `.git`.
 *
 * Checked with `stat` rather than `isDirectory`, because a worktree or
 * submodule has a `.git` *file* pointing elsewhere and is still a repo root.
 * Returns null when the search reaches the filesystem root without a hit —
 * callers treat that as "not in a repo" rather than guessing.
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir)
  for (;;) {
    try {
      await stat(path.join(dir, '.git'))
      return dir
    } catch {
      // not here; keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Loads the project's conventions file so the agent follows repo-local
 * rules without the user restating them every session.
 *
 * Deliberately anchored to the repo root, not the working directory: the
 * conventions that govern a repo shouldn't change based on which
 * subdirectory the CLI happened to be started from. Returns null when there
 * is no repo, no instructions file, or the file is empty — an empty file is
 * treated as absent so it cannot inject a blank system message.
 */
export async function loadProjectInstructions(
  options: LoadInstructionsOptions = {},
): Promise<ProjectInstructions | null> {
  const { cwd = process.cwd(), maxBytes = MAX_INSTRUCTIONS_BYTES } = options

  const root = await findRepoRoot(cwd)
  if (root === null) return null

  for (const name of INSTRUCTION_FILENAMES) {
    const source = path.join(root, name)
    let raw: string
    try {
      raw = await readFile(source, 'utf8')
    } catch {
      continue // missing or unreadable — try the next candidate
    }

    if (raw.trim().length === 0) return null

    const truncated = Buffer.byteLength(raw, 'utf8') > maxBytes
    const text = truncated
      ? `${Buffer.from(raw, 'utf8').subarray(0, maxBytes).toString('utf8')}\n\n[instructions truncated]`
      : raw
    return { text: text.trim(), source, root, truncated }
  }

  return null
}

/**
 * Wraps the file contents in a system message.
 *
 * The framing says where the text came from and how much authority it
 * carries: project conventions lose to a direct instruction from the user,
 * otherwise a stale line in a checked-in file would outrank the person
 * typing right now.
 */
export function buildSystemPrompt(instructions: ProjectInstructions): string {
  return [
    `Project conventions from ${path.basename(instructions.source)}, which apply to work in this repository.`,
    'Follow them unless the user directly asks for something else — a live instruction from the user wins.',
    '',
    instructions.text,
  ].join('\n')
}
