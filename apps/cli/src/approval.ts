import type { ApprovalDecision, ApprovalHandler, ToolCall, ToolDefinition } from '@open-agent/agent'
import { colorizeDiff } from './diff-view.js'

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

export interface PlanApprovalOptions {
  /**
   * Colorize the diff shown (ANSI escapes). Safe to leave off in an Ink TUI,
   * which renders raw escape sequences as text rather than as styling.
   */
  color?: boolean
}

/**
 * The approval handler for plan mode (`--plan`). A tool carrying a plan-mode
 * preview is presented as the diff of what it would change, and approving the
 * change _is_ the approval — the write only runs after a "yes". Every other
 * tool falls through to the ordinary terminal prompt, so shell commands,
 * HTTP calls and friends behave exactly as they did without plan mode.
 *
 * Scopes are once-or-task, and there is deliberately no "always": a file
 * write that never prompts again defeats the point of plan mode. A task-scope
 * "yes" is remembered by the registry for the exact same path and content, so
 * a model retry of an approved change does not re-prompt.
 */
export function createPlanApprovalHandler(
  ask: (question: string) => Promise<string>,
  write?: (text: string) => void,
  options: PlanApprovalOptions = {},
): ApprovalHandler {
  const terminal = createTerminalApprovalHandler(ask)

  return async (call: ToolCall, tool: ToolDefinition, ctx): Promise<boolean | ApprovalDecision> => {
    if (ctx.planPreview === undefined) return terminal(call, tool, ctx)

    const diff = options.color ? colorizeDiff(ctx.planPreview) : ctx.planPreview
    const subject = typeof call.args.path === 'string' ? call.args.path : call.name
    const block = `\nPlan review — "${tool.name}" would change "${subject}" as follows:\n\n${diff}`
    const prompt = `\nApprove this change? [y]es once / [t]ask / [N]o `

    let answer: string
    if (write) {
      // A stream gets the whole diff so a TUI can render it as a transcript
      // entry; the prompt that follows stays short instead of becoming a
      // mile-long input label.
      write(`${block}\n`)
      answer = await ask(prompt)
    } else {
      answer = await ask(`${block}\n${prompt}`)
    }

    const decision = answer.trim().toLowerCase()

    if (decision.startsWith('y')) return { approved: true, scope: 'once' }
    if (decision.startsWith('t')) return { approved: true, scope: 'task' }
    return DENIED
  }
}
