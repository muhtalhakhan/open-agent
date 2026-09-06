import path from 'node:path'
import fs from 'node:fs/promises'

/** A path argument that the workspace root refuses, as opposed to an I/O failure. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

/** True when `target` is the root itself or sits underneath it. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Turn a model-supplied path into an absolute one that is provably inside the
 * workspace root, or throw.
 *
 * The lexical check (`path.resolve` then `isInside`) is not enough on its own:
 * a symlink inside the root can point anywhere, so an existing target is also
 * resolved through `realpath` and re-checked. A path that does not exist yet
 * passes on the lexical check alone — whether that is an error is the calling
 * tool's decision, not this function's.
 */
export async function resolveInWorkspace(root: string, requested: unknown): Promise<string> {
  return (await resolvePathInWorkspace(root, requested)).absolute
}

/** A path proved to be inside the workspace, with the root-relative form the file policy matches on. */
export interface ResolvedPath {
  /** Absolute, symlinks resolved where the target exists. */
  absolute: string
  /**
   * Relative to the workspace root, always with forward slashes so one set of
   * glob patterns works on every platform. Empty string for the root itself.
   */
  relative: string
}

/**
 * The same resolution as `resolveInWorkspace`, keeping the root-relative path
 * it had to compute anyway. Tools need both: the absolute path to open, and
 * the relative one to check against the file policy — and re-deriving the
 * second would mean a second `realpath` of the root on every call.
 */
export async function resolvePathInWorkspace(root: string, requested: unknown): Promise<ResolvedPath> {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new WorkspaceError('path is required')
  }
  // The root itself may be reached through a symlink (/tmp on macOS is the
  // usual one); comparing against its unresolved form would reject everything.
  const realRoot = await fs.realpath(root)
  const absolute = path.resolve(realRoot, requested)
  if (!isInside(realRoot, absolute)) {
    throw new WorkspaceError(`path "${requested}" is outside the workspace root`)
  }

  let real: string
  try {
    real = await fs.realpath(absolute)
  } catch {
    return { absolute, relative: toPosix(path.relative(realRoot, absolute)) }
  }
  if (!isInside(realRoot, real)) {
    throw new WorkspaceError(`path "${requested}" resolves through a symlink to outside the workspace root`)
  }
  return { absolute: real, relative: toPosix(path.relative(realRoot, real)) }
}

/** Windows separators normalised away, so a glob written with `/` matches everywhere. */
export function toPosix(relative: string): string {
  return relative.split(path.sep).join('/')
}
