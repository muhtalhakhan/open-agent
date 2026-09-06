import type { ToolRegistry } from '@open-agent/agent'
import type { Workspace } from '@open-agent/tools-files'
import { ProcessRegistry } from './process-registry.js'
import { processTools } from './process-tools.js'
import { runCommandTool } from './run-command.js'
import type { CommandPolicy } from './policy.js'

export interface MountTerminalOptions extends CommandPolicy {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  allowEnv?: readonly string[]
  maxRunning?: number
}

/**
 * Registers the shell tools against one workspace, and hands back a disposer
 * that kills whatever they left running.
 *
 * The disposer is the reason this exists rather than four `register` calls at
 * the call site: a background process outlives the tool call that started it,
 * so something has to own the end of its life. Tying that to the workspace
 * means a session cannot leak a dev server into the machine it ran on.
 */
export function mountTerminalTools(
  registry: ToolRegistry,
  workspace: Workspace,
  options: MountTerminalOptions = {},
): () => void {
  const processes = new ProcessRegistry({ maxRunning: options.maxRunning })
  const shared = { root: workspace.root, ...options }

  const disposers = [
    registry.register(runCommandTool(shared)),
    ...processTools({ ...shared, registry: processes }).map((tool) => registry.register(tool)),
  ]

  return () => {
    processes.disposeAll()
    disposers.forEach((dispose) => dispose())
  }
}
