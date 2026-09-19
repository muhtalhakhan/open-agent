import type { PermissionLevel, ToolCall, ToolDefinition, ToolExecutionContext, ToolResult } from './types.js'
import { fenceUntrusted } from './untrusted.js'

/** How long an approval lasts. */
export type ApprovalScope = 'once' | 'task' | 'session'

/**
 * What a remembered approval covers. `exact` remembers this argument set and
 * nothing else; `tool` remembers the whole tool.
 *
 * `exact` is the default, and deliberately. "Approve run_command for this
 * task" reads like a small convenience and means every subsequent command
 * runs unprompted — which is close to not having approval at all. Remembering
 * the exact call keeps the prompt where the decision actually changes.
 */
export type ApprovalMatch = 'exact' | 'tool'

export interface ApprovalDecision {
  approved: boolean
  /** Defaults to `once`. */
  scope?: ApprovalScope
  /** Defaults to `exact`. */
  match?: ApprovalMatch
}

/** Which run a call belongs to, for a handler that answers differently per task. */
export interface ApprovalContext {
  taskId: string
}

/**
 * Returns `true`/`false` for a one-off decision, or an `ApprovalDecision` to
 * have the answer remembered for the rest of the task or the session.
 *
 * `context` names the task asking. A host running several tasks at once needs
 * it to route the question: a task in the background has nobody watching it,
 * and must not put a prompt in front of someone answering a different one.
 */
export type ApprovalHandler = (
  call: ToolCall,
  tool: ToolDefinition,
  context: ApprovalContext,
) => boolean | ApprovalDecision | Promise<boolean | ApprovalDecision>

/** Why a call was allowed to run, as recorded in the audit log. */
export type ApprovalSource = 'safe' | 'granted' | 'remembered' | 'denied'

export interface ApprovalGrant {
  tool: string
  match: ApprovalMatch
  scope: Exclude<ApprovalScope, 'once'>
  /** Present for a task-scoped grant: the task it belongs to. */
  taskId?: string
  /** The arguments it covers, for an `exact` grant. */
  args?: Record<string, unknown>
}

/**
 * Canonical form of a call's arguments, for matching a remembered approval
 * against a later call. Keys are sorted so that `{a,b}` and `{b,a}` — which
 * a model produces interchangeably — are the same decision.
 */
function argumentKey(args: Record<string, unknown>): string {
  return JSON.stringify(args, Object.keys(args).sort())
}

/**
 * The scoped tool registry and guarded execution pipeline. Every tool
 * declares a permission level; anything above "safe" is denied unless an
 * approval handler explicitly allows it. This is the one place a tool call
 * turns into a side effect, so it is also where audit logging hooks in.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly enabledDangerous = new Set<string>()
  private approvalHandler: ApprovalHandler = () => false
  private isUnattended: (taskId: string) => boolean = () => false
  /** Remembered approvals, keyed by tool and (for `exact` grants) arguments. */
  private readonly grants = new Map<string, ApprovalGrant>()
  /** Tasks that have read output from an `untrustedOutput` tool. */
  private readonly tainted = new Set<string>()
  readonly auditLog: Array<{
    call: ToolCall
    permissionLevel: PermissionLevel
    approved: boolean
    /**
     * Whether a human answered for this call or a previous answer covered it.
     * Without the distinction the log says "approved" for a call nobody saw,
     * and stops meaning what a reader takes it to mean.
     */
    approvalSource: ApprovalSource
    result: ToolResult
  }> = []

  register(tool: ToolDefinition): () => void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`)
    }
    this.tools.set(tool.name, tool)
    return () => this.tools.delete(tool.name)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  /** Allow a specific tool's "dangerous" level to even be offered/approved. */
  enableDangerous(name: string): void {
    this.enabledDangerous.add(name)
  }

  onApproval(handler: ApprovalHandler): void {
    this.approvalHandler = handler
  }

  /**
   * Names the tasks that run with nobody watching — background jobs, say.
   * Remembered approvals do not cover them: an "always allow" was given by
   * someone watching a task they could see, not a blank cheque for work they
   * will never look at. Every call from such a task goes to the approval
   * handler, which answers it by policy.
   */
  setUnattended(predicate: (taskId: string) => boolean): void {
    this.isUnattended = predicate
  }

  private grantKey(tool: string, match: ApprovalMatch, args: Record<string, unknown>): string {
    return match === 'tool' ? `${tool}|*` : `${tool}|${argumentKey(args)}`
  }

  /** A remembered approval covering this call, if there is one. */
  private findGrant(call: ToolCall, taskId: string): ApprovalGrant | undefined {
    for (const match of ['exact', 'tool'] as const) {
      const grant = this.grants.get(this.grantKey(call.name, match, call.args))
      if (!grant) continue
      if (grant.scope === 'task' && grant.taskId !== taskId) continue
      return grant
    }
    return undefined
  }

  private async decide(call: ToolCall, tool: ToolDefinition, taskId: string): Promise<ApprovalSource> {
    if (tool.permissionLevel === 'safe') return 'safe'
    if (tool.permissionLevel === 'dangerous' && !this.enabledDangerous.has(tool.name)) return 'denied'

    // A `dangerous` call is never covered by a remembered approval, and its
    // answer is never remembered. The whole point of the level is that each
    // one is looked at; a grant would quietly undo that.
    //
    // Nor is any call from a task that has read untrusted content. The user
    // who said "always allow" was deciding about calls *they* would cause; once
    // a web page has had its say, the next call may be the page's idea. Asking
    // again is how untrusted content is kept from borrowing the user's standing
    // approval — the same threshold holds, it just cannot be pre-paid. The
    // same goes for an unattended task (see `setUnattended`), which nobody is
    // watching to have granted anything to.
    if (
      tool.permissionLevel !== 'dangerous' &&
      !this.tainted.has(taskId) &&
      !this.isUnattended(taskId) &&
      this.findGrant(call, taskId)
    ) {
      return 'remembered'
    }

    const decision = await this.approvalHandler(call, tool, { taskId })
    const {
      approved,
      scope = 'once',
      match = 'exact',
    } = typeof decision === 'boolean' ? { approved: decision } : decision
    if (!approved) return 'denied'

    if (scope !== 'once' && tool.permissionLevel !== 'dangerous') {
      this.grants.set(this.grantKey(call.name, match, call.args), {
        tool: call.name,
        match,
        scope,
        taskId: scope === 'task' ? taskId : undefined,
        args: match === 'exact' ? call.args : undefined,
      })
    }
    return 'granted'
  }

  /** Whether a task has read output from a tool marked `untrustedOutput`. */
  isTainted(taskId: string): boolean {
    return this.tainted.has(taskId)
  }

  /**
   * Marks a task as having read untrusted content without running a tool —
   * for a task resumed with that content already in its history.
   */
  taint(taskId: string): void {
    this.tainted.add(taskId)
  }

  /** What is currently remembered, so a user can see what will not prompt again. */
  listApprovals(): ApprovalGrant[] {
    return [...this.grants.values()]
  }

  /** Forgets remembered approvals — all of them, or one tool's. */
  revokeApprovals(tool?: string): void {
    if (tool === undefined) {
      this.grants.clear()
      return
    }
    for (const [key, grant] of this.grants) {
      if (grant.tool === tool) this.grants.delete(key)
    }
  }

  /**
   * Drops the grants belonging to a finished task. Called by the agent loop at
   * `turn/end`: a task-scoped approval that outlived its task would be a
   * session-scoped one the user never agreed to.
   */
  endTask(taskId: string): void {
    this.tainted.delete(taskId)
    for (const [key, grant] of this.grants) {
      if (grant.scope === 'task' && grant.taskId === taskId) this.grants.delete(key)
    }
  }

  /** Run one tool call through the pre-execute policy gate, execution, and audit log. */
  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name)
    if (!tool) {
      const result: ToolResult = { ok: false, content: '', error: `unknown tool "${call.name}"` }
      return result
    }

    const approvalSource = await this.decide(call, tool, context.taskId)
    if (approvalSource === 'denied') {
      const result: ToolResult = {
        ok: false,
        content: '',
        error: `tool "${call.name}" requires approval and was not approved`,
      }
      this.auditLog.push({
        call,
        permissionLevel: tool.permissionLevel,
        approved: false,
        approvalSource,
        result,
      })
      return result
    }

    let result: ToolResult
    try {
      result = await tool.execute(call.args, context)
    } catch (err) {
      result = { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
    }
    this.auditLog.push({ call, permissionLevel: tool.permissionLevel, approved: true, approvalSource, result })
    if (!tool.untrustedOutput) return result

    // Fenced here, where it is known the tool itself produced the text, and
    // not for the registry's own refusals above: those are the user's
    // decisions, and fencing one would tell the model to treat it as outside
    // data. Tainted whatever the outcome — an error can carry the remote
    // side's text just as well as a success can. The audit log keeps the raw
    // output.
    this.tainted.add(context.taskId)
    return fenceResult(result, call.name)
  }
}

/** Fences whichever part of a result carries the remote side's text. */
function fenceResult(result: ToolResult, source: string): ToolResult {
  if (result.ok) return { ...result, content: fenceUntrusted(result.content, source) }
  return result.error === undefined ? result : { ...result, error: fenceUntrusted(result.error, source) }
}
