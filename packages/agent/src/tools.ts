import type {
  PermissionLevel,
  SessionEvent,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from './types.js'
import { fenceUntrusted } from './untrusted.js'
import {
  destinationsIn,
  destinationsInText,
  detectExfiltration,
  newTaskActivity,
  type Escalation,
  type TaskActivity,
} from './dangerous-actions.js'

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
  /**
   * Set when a sequence rule put this call up for approval rather than its own
   * permission level — see `dangerous-actions.ts`. A handler should show the
   * reason: the user is being asked about a `safe` call, and without it the
   * prompt is inexplicable.
   */
  escalation?: Escalation
  /**
   * Present when the tool offered a preview of its change and plan mode is on,
   * so the person deciding reviews the diff rather than the bare arguments.
   */
  planPreview?: string
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
  /** What each live task has read and where it has already been, for the sequence rules. */
  private readonly activity = new Map<string, TaskActivity>()

  private plansEnabled = false
  readonly auditLog: Array<{
    call: ToolCall
    permissionLevel: PermissionLevel
    approved: boolean
    /** The sequence rule that forced this call to be asked about, if one did. */
    escalation?: Escalation
    /**
     * Whether a human answered for this call or a previous answer covered it.
     * Without the distinction the log says "approved" for a call nobody saw,
     * and stops meaning what a reader takes it to mean.
     */
    approvalSource: ApprovalSource
    result: ToolResult
    /** The tool's preview ("diff") if the call carried one. */
    planPreview?: string
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
   * Turn on plan mode: a tool that offers a `plan` preview is reviewed as a
   * diff before it runs instead of being approved (or auto-run, if `safe`)
   * on its arguments alone. Opt-in — without it `plan` hooks are inert.
   */
  enablePlans(): void {
    this.plansEnabled = true
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

  /** The sequence-rule state for a task, created on first use. */
  private activityFor(taskId: string): TaskActivity {
    let state = this.activity.get(taskId)
    if (!state) {
      state = newTaskActivity()
      this.activity.set(taskId, state)
    }
    return state
  }

  /**
   * Tells the rules what the user actually asked for, so a destination they
   * named themselves does not prompt. Called by the agent loop with each user
   * message, and so re-derived from the session log on a resumed task.
   */
  noteUserRequest(taskId: string, text: string): void {
    const state = this.activityFor(taskId)
    for (const host of destinationsInText(text)) state.known.add(host)
  }

  /**
   * Rebuilds a task's sequence-rule state from its session log.
   *
   * `endTask` drops that state, but the conversation keeps every word of it: a
   * follow-up turn, or a session resumed in a new process, has read what the
   * earlier turns read. Without this the rule would be escapable by simply
   * waiting for the turn to end — read the file in one turn, send it in the
   * next — which is no barrier at all. The same replay restores the
   * destinations already reached, so a host used honestly last turn does not
   * start prompting this turn.
   */
  replayTask(taskId: string, events: readonly SessionEvent[]): void {
    const state = this.activityFor(taskId)
    const pending = new Map<string, ToolCall>()
    for (const event of events) {
      if (event.type === 'user/message') {
        for (const host of destinationsInText(event.message.content)) state.known.add(host)
        continue
      }
      if (event.type === 'tool/call') {
        pending.set(event.call.id, event.call)
        continue
      }
      if (event.type !== 'tool/result') continue
      const call = pending.get(event.callId)
      if (call === undefined) continue
      // Only a call that succeeded settles its destination. The log holds a
      // `tool/call` for refused calls too, and replaying those would hand a
      // task the one thing the user just denied it: read the page, be refused
      // the send, and have the destination waved through next turn.
      if (event.result.ok) {
        for (const host of destinationsIn(call.args)) state.known.add(host)
      }
      if (event.result.content || event.result.error) state.ingested.add(call.name)
    }
  }

  private async decide(
    call: ToolCall,
    tool: ToolDefinition,
    context: ToolExecutionContext,
  ): Promise<{ source: ApprovalSource; escalation?: Escalation; planPreview?: string; plannedError?: string }> {
    // Before the permission level, because the whole point is a call whose own
    // level would have let it through unexamined.
    const taskId = context.taskId
    const escalation = detectExfiltration(call, this.activityFor(taskId))

    // In plan mode a tool that provides a preview is a review, not a
    // checklist item — so even a `safe` file edit is put in front of a
    // human. Without a preview, a `safe` tool stays automatic.
    const interactive = this.plansEnabled && tool.plan !== undefined

    if (tool.permissionLevel === 'safe' && !escalation && !interactive) return { source: 'safe' }
    if (tool.permissionLevel === 'dangerous' && !this.enabledDangerous.has(tool.name)) return { source: 'denied' }

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
    //
    // Nor is an escalated one. A rule fires precisely when this call is unlike
    // the ones the user was answering about when they said "always", so
    // spending that grant here would let the rule be silenced by an approval
    // given before there was anything to detect.
    if (
      tool.permissionLevel !== 'dangerous' &&
      !escalation &&
      !this.tainted.has(taskId) &&
      !this.isUnattended(taskId) &&
      this.findGrant(call, taskId)
    ) {
      return { source: 'remembered' }
    }

    let planPreview: string | undefined
    if (interactive) {
      const planned = await tool.plan!(call.args, context)
      // A preview that failed is the tool telling us the write would fail the
      // same way; deny without asking a human to rubber-stamp a doomed call.
      if (!planned.ok) return { source: 'denied', planPreview: planned.error, plannedError: planned.error }
      planPreview = planned.content
    }

    const decision = await this.approvalHandler(call, tool, { taskId, escalation, planPreview })
    const {
      approved,
      scope = 'once',
      match = 'exact',
    } = typeof decision === 'boolean' ? { approved: decision } : decision
    if (!approved) return { source: 'denied', escalation, planPreview }

    // An escalated call is approved for this once and no further. Remembering
    // it would remember the rule's own trigger away.
    if (scope !== 'once' && !escalation && tool.permissionLevel !== 'dangerous') {
      this.grants.set(this.grantKey(call.name, match, call.args), {
        tool: call.name,
        match,
        scope,
        taskId: scope === 'task' ? taskId : undefined,
        args: match === 'exact' ? call.args : undefined,
      })
    }
    return { source: 'granted', escalation, planPreview }
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
    this.activity.delete(taskId)
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

    const { source: approvalSource, escalation, planPreview, plannedError } = await this.decide(call, tool, context)
    if (approvalSource === 'denied') {
      const result: ToolResult = {
        ok: false,
        content: '',
        error:
          plannedError ??
          (escalation
            ? `tool "${call.name}" was not approved: ${escalation.reason}`
            : `tool "${call.name}" requires approval and was not approved`),
      }
      this.auditLog.push({
        call,
        permissionLevel: tool.permissionLevel,
        approved: false,
        approvalSource,
        escalation,
        planPreview,
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
    this.auditLog.push({
      call,
      permissionLevel: tool.permissionLevel,
      approved: true,
      approvalSource,
      escalation,
      planPreview,
      result,
    })

    // Only a call that has actually run and succeeded settles its destination:
    // one the user refused must never become one the rules consider settled,
    // and a failed call is not evidence the destination was reached. This
    // matches what `replayTask` can reconstruct from the log, where a refusal
    // and a failure look alike, so the same task judges the same either way.
    const activity = this.activityFor(context.taskId)
    if (result.ok) {
      for (const host of destinationsIn(call.args)) activity.known.add(host)
    }
    // Content coming back is what there is to exfiltrate later. An error body
    // counts — it carries the far side's text as readily as a success does.
    if (result.content || result.error) activity.ingested.add(call.name)

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
