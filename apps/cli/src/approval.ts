import type { ApprovalHandler, ToolCall, ToolDefinition } from '@open-agent/agent'

/**
 * Prompts the user in the terminal before an `ask`/`dangerous` tool runs.
 * `ask` is a function so tests can inject a fake prompt instead of real stdin.
 */
export function createTerminalApprovalHandler(ask: (question: string) => Promise<string>): ApprovalHandler {
  return async (call: ToolCall, tool: ToolDefinition) => {
    const args = JSON.stringify(call.args)
    const answer = await ask(`\n⚠ Approve "${tool.name}" (${tool.permissionLevel}) with args ${args}? [y/N] `)
    return answer.trim().toLowerCase().startsWith('y')
  }
}

/**
 * The approval policy for print mode, where nobody is watching to answer a
 * prompt. Denies by default — a CI job that silently performs a side effect
 * nobody sanctioned is worse than one that fails — and approves `ask`-level
 * calls only when the operator opted in with `--yes`.
 *
 * `dangerous` tools never reach here unless `ToolRegistry.enableDangerous`
 * named them explicitly, so `--yes` cannot escalate to that level.
 */
export function createNonInteractiveApprovalHandler(approveAsk: boolean, log: (msg: string) => void): ApprovalHandler {
  return (call: ToolCall, tool: ToolDefinition) => {
    if (approveAsk) {
      log(`auto-approved "${tool.name}" (${tool.permissionLevel}) — running with --yes\n`)
      return true
    }
    log(`denied "${tool.name}" (${tool.permissionLevel}): no human to approve; re-run with --yes to allow\n`)
    return false
  }
}
