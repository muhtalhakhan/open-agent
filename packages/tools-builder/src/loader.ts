/**
 * Loads user-built tool specs from `~/.openagent/tools/` and registers them.
 *
 * Security constraints (per issue #285):
 * - Only loads from the user's personal folder (`~/.openagent/tools/`)
 * - Never loads from system/shared locations
 * - Built tools are NEVER marked `safe`; always `dangerous`
 * - User approval is a hard gate (the loader skips unapproved files)
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import type { ToolRegistry } from '@open-agent/agent'
import type { SavedToolFile, ToolSpec } from './spec-types.js'
import { buildShellTool, buildHttpTool } from './builder.js'

/** Path to the user's personal tool folder. */
export const USER_TOOLS_DIR = join(homedir(), '.openagent', 'tools')

/** Whether the folder exists and is a directory. */
export async function userToolsDirExists(): Promise<boolean> {
  try {
    const s = await stat(USER_TOOLS_DIR)
    return s.isDirectory()
  } catch {
    return false
  }
}

/** Load a single saved tool file. */
export async function loadSavedTool(
  filePath: string,
): Promise<{ name: string; spec: ToolSpec; file: SavedToolFile } | null> {
  try {
    const text = await readFile(filePath, 'utf-8')
    const file = JSON.parse(text) as SavedToolFile
    if (file.specVersion !== 1) return null // only version 1 supported
    if (!file.spec || typeof file.spec !== 'object') return null
    if (file.spec.kind !== 'shell' && file.spec.kind !== 'http') return null
    const name = filePath
      .split(/[\\/]/)
      .pop()!
      .replace(/\.json$/, '')
    return { name, spec: file.spec, file }
  } catch {
    return null
  }
}

/** What a failed load should say. Absent means the failure is only reported through the return value. */
export type LoadReporter = (message: string) => void

/** Load all approved tool specs from the user's folder. */
export async function loadUserTools(
  report?: LoadReporter,
): Promise<Array<{ name: string; spec: ToolSpec; file: SavedToolFile }>> {
  const dir = USER_TOOLS_DIR
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    // A missing folder is the normal case for someone who has never built a
    // tool; anything else (permissions, an unreadable path) is worth saying.
    return []
  }

  const results: Array<{ name: string; spec: ToolSpec; file: SavedToolFile }> = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const fullPath = join(dir, entry)
    // Only regular files qualify: a symlink could point anywhere on disk,
    // and a directory named x.json is not readable as JSON anyway.
    let statResult
    try {
      statResult = lstatSync(fullPath)
    } catch {
      report?.(`Skipped ${fullPath}: could not stat entry.`)
      continue
    }
    if (!statResult.isFile()) {
      report?.(`Skipped ${fullPath}: not a regular file.`)
      continue
    }
    const loaded = await loadSavedTool(fullPath)
    if (loaded) results.push(loaded)
    else report?.(`Skipped ${fullPath}: not a readable specVersion 1 tool file.`)
  }
  return results
}

/**
 * Register a loaded user tool with the registry. Always dangerous.
 *
 * Throws when the name is taken. A saved file is named by whoever approved
 * it, so letting one claim a built-in tool's name (`run_command`, `write_file`)
 * would hand the model a different tool under a name it already trusts —
 * failing at mount is the safe answer, and the caller reports it.
 */
export function registerUserTool(registry: ToolRegistry, loaded: { name: string; spec: ToolSpec }): () => void {
  const definition =
    loaded.spec.kind === 'shell'
      ? { ...buildShellTool(loaded.spec), name: loaded.name }
      : { ...buildHttpTool(loaded.spec), name: loaded.name }
  // Built tools are never safe; always dangerous (enforced in builder already)
  return registry.register(definition)
}

/**
 * Mount all loaded user tools onto a registry, returning a disposer.
 *
 * One bad file must not stop the CLI from starting, so each tool registers
 * independently and a failure is reported rather than thrown. That keeps a
 * hand-edited spec (or a duplicate name) from taking the whole session down
 * while still making the reason visible.
 */
export async function mountUserBuiltTools(
  registry: ToolRegistry,
  options: { report?: LoadReporter } = {},
): Promise<() => void> {
  const report = options.report ?? (() => {})
  const loaded = await loadUserTools(report)
  const disposers: Array<() => void> = []
  for (const entry of loaded) {
    try {
      disposers.push(registerUserTool(registry, entry))
    } catch (e) {
      report(`Could not load ${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return () => {
    for (const d of disposers) d()
  }
}
