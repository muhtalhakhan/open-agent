import type { ToolRegistry } from '@open-agent/agent'
import { listDirectoryTool } from './list-directory.js'
import { readFileTool } from './read-file.js'
import { searchFilesTool } from './search-files.js'
import { writeFileTool } from './write-file.js'
import type { Workspace } from './session-workspace.js'

/**
 * Registers every file tool against one workspace.
 *
 * The point is that they cannot disagree. Configuring each tool separately
 * made it possible to give `read_file` one root and `write_file` another, or
 * to deny a path for reads and forget to deny it for search — which would
 * have let a search print the contents of a file the policy said could not be
 * read. One workspace in, four tools out, no opportunity to skew.
 */
export function mountFileTools(registry: ToolRegistry, workspace: Workspace): () => void {
  const options = { root: workspace.root, policy: workspace.policy }
  const disposers = [
    registry.register(readFileTool(options)),
    registry.register(listDirectoryTool(options)),
    registry.register(searchFilesTool(options)),
    registry.register(writeFileTool(options)),
  ]
  return () => disposers.forEach((dispose) => dispose())
}
