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
  return async (call: ToolCall, tool: ToolDefinition, context): Promise<ApprovalDecision> => {
    const args = JSON.stringify(call.args)
    const escalation = context?.escalation
    // A sequence rule's call is never remembered by the registry, so offering
    // to remember it would be offering something that does not happen.
    const rememberable = tool.permissionLevel !== 'dangerous' && !escalation
    const options = rememberable ? '[y]es once / [t]ask / [a]lways / [N]o' : '[y]es once / [N]o'
    // The reason leads. An escalated call is often a `safe` one, and a prompt
    // about `read_file` with no explanation reads as a bug rather than a
    // warning — the user would learn to dismiss it.
    const preamble = escalation
      ? `\n⚠ Held for review — ${escalation.rule}\n  ${escalation.reason}\n  Call: "${tool.name}" with args ${args}\n`
      : `\n⚠ Approve "${tool.name}" (${tool.permissionLevel}) with args ${args}?\n`
    const answer = (await ask(`${preamble}  ${options} `)).trim().toLowerCase()

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
  return (call: ToolCall, tool: ToolDefinition, context): ApprovalDecision | boolean => {
    // Named either way: with `--yes` this is the only trace a flagged call
    // leaves in front of the operator, and it is the one worth reading.
    const flagged = context?.escalation ? ` [${context.escalation.rule}: ${context.escalation.reason}]` : ''
    if (approveAsk) {
      log(`auto-approved "${tool.name}" (${tool.permissionLevel}) — running with --yes${flagged}\n`)
      return true
    }
    log(`denied "${tool.name}" (${tool.permissionLevel}): no human to approve; re-run with --yes to allow${flagged}\n`)
    return false
  }
}

/**
 * Sends each approval question to whoever can answer it: the terminal for the
 * task in the foreground, the unattended policy for a background job.
 *
 * A background job prompting on the terminal would put its question in front
 * of someone answering a different task's — they could approve one while
 * believing they were approving the other. So it gets the same answer print
 * mode does: denied, unless the session was started with `--yes`.
 */
export function createRoutingApprovalHandler(
  isBackground: (taskId: string) => boolean,
  foreground: ApprovalHandler,
  background: ApprovalHandler,
): ApprovalHandler {
  return (call, tool, context) =>
    isBackground(context.taskId) ? background(call, tool, context) : foreground(call, tool, context)
}
