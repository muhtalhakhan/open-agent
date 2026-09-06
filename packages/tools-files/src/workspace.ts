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
    return absolute
  }
  if (!isInside(realRoot, real)) {
    throw new WorkspaceError(`path "${requested}" resolves through a symlink to outside the workspace root`)
  }
  return real
}
