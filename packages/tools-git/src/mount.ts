import type { ToolRegistry } from '@open-agent/agent'
import type { Workspace } from '@open-agent/tools-files'
import { gitBranchTool } from './branch.js'
import { gitCommitTool } from './commit.js'
import { gitDiffTool } from './diff.js'
import { gitLogTool } from './log.js'
import { gitStatusTool } from './status.js'

/**
 * Registers the git tools against the workspace the file tools use, with the
 * same policy, so a file `read_file` may not read cannot be diffed or
 * committed either.
 */
export function mountGitTools(registry: ToolRegistry, workspace: Workspace): () => void {
  const options = { root: workspace.root, policy: workspace.policy }
  const disposers = [
    registry.register(gitStatusTool(options)),
    registry.register(gitDiffTool(options)),
    registry.register(gitLogTool(options)),
    registry.register(gitCommitTool(options)),
    registry.register(gitBranchTool(options)),
  ]
  return () => disposers.forEach((dispose) => dispose())
}
