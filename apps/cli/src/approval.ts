import type { ApprovalDecision, ApprovalHandler, ToolCall, ToolDefinition } from '@open-agent/agent'

const DENIED: ApprovalDecision = { approved: false }

/**
 * Prompts the user in the terminal before an `ask`/`dangerous` tool runs.
 * `ask` is a function so tests can inject a fake prompt instead of real stdin.
 *
 * Four answers rather than two. Twenty identical prompts answered `y` in a row
 * is not twenty decisions, it is one decision and nineteen rubber stamps —
 * offering to remember the answer is what keeps the prompts that remain worth
 * reading.
 *
 * `a` (always) is confirmed a second time, per docs/security-model.md: it
 * removes future prompts entirely, so it should not be reachable by someone
 * tabbing through the first one. A `dangerous` tool is offered neither, since
 * the registry will not remember it anyway.
 */
export function createTerminalApprovalHandler(ask: (question: string) => Promise<string>): ApprovalHandler {
  return async (call: ToolCall, tool: ToolDefinition): Promise<ApprovalDecision> => {
    const args = JSON.stringify(call.args)
    const rememberable = tool.permissionLevel !== 'dangerous'
    const options = rememberable ? '[y]es once / [t]ask / [a]lways / [N]o' : '[y]es once / [N]o'
    const answer = (await ask(`\n⚠ Approve "${tool.name}" (${tool.permissionLevel}) with args ${args}?\n  ${options} `))
      .trim()
      .toLowerCase()

    if (answer.startsWith('y')) return { approved: true, scope: 'once' }
    if (!rememberable) return DENIED

    if (answer.startsWith('t')) return { approved: true, scope: 'task' }
    if (answer.startsWith('a')) {
      const confirm = await ask(`  Always approve "${tool.name}" with these arguments, for the whole session? [y/N] `)
      if (!confirm.trim().toLowerCase().startsWith('y')) return DENIED
      return { approved: true, scope: 'session' }
    }
    return DENIED
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
  return (call: ToolCall, tool: ToolDefinition): ApprovalDecision | boolean => {
    if (approveAsk) {
      log(`auto-approved "${tool.name}" (${tool.permissionLevel}) — running with --yes\n`)
      return true
    }
    log(`denied "${tool.name}" (${tool.permissionLevel}): no human to approve; re-run with --yes to allow\n`)
    return false
  }
}
