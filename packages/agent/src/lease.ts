import type { SessionLog } from './session.js'
import type { LeaseState, TakeoverOutcome, TakeoverRequest } from './types.js'

/**
 * Who is driving, and how control passes between the agent and a person.
 *
 * Two situations turn out to be the same primitive. "I want to take the
 * wheel" and "the agent has hit a login wall and needs a human" are both an
 * exclusive handoff: the agent stops acting, a person acts, and control comes
 * back. Building them as one thing keeps a single answer to "who is driving
 * right now" instead of two mechanisms that can disagree.
 *
 * Credentials are the reason this is a handoff rather than a question. The
 * agent must never ask for a password — it asks the *person* to go and log in
 * themselves, in their own browser, where the secret never passes through the
 * model, the transcript, or the provider. That is only true if there is no
 * channel for it to come back on, so a takeover returns an outcome and
 * nothing else: there is no free-text field a password could be typed into.
 * See docs/security-model.md.
 */

/** Runs the handoff in whatever interface the host has — a terminal, a viewer. */
export type TakeoverHandler = (
  request: TakeoverRequest,
  /** Called once the person has accepted and is actually driving. */
  grant: () => void,
  signal: AbortSignal,
) => Promise<TakeoverOutcome>

export interface LeaseManagerOptions {
  sessions: SessionLog
  handler: TakeoverHandler
  /**
   * Tasks nobody is watching, as `ToolRegistry.setUnattended` names them. A
   * background job asking for a takeover would wait on a person who is not
   * there and never time out, hanging the job rather than failing it.
   */
  isUnattended?: (taskId: string) => boolean
}

export class LeaseManager {
  private readonly leases = new Map<string, LeaseState>()
  private readonly sessions: SessionLog
  private readonly handler: TakeoverHandler
  private readonly isUnattended: (taskId: string) => boolean

  constructor({ sessions, handler, isUnattended = () => false }: LeaseManagerOptions) {
    this.sessions = sessions
    this.handler = handler
    this.isUnattended = isUnattended
  }

  /** Who holds the lease for a task. The agent, unless a handoff is under way. */
  state(taskId: string): LeaseState {
    return this.leases.get(taskId) ?? { holder: 'agent' }
  }

  /**
   * Hands control to a person and waits for it back.
   *
   * Every transition is appended to the session log before it is acted on, so
   * the transcript shows when the agent stopped and when it resumed. What the
   * model is told is the returned outcome — it learns that a person dealt with
   * it, never what they typed.
   */
  async handOver(request: TakeoverRequest, signal: AbortSignal): Promise<TakeoverOutcome> {
    const { taskId } = request

    // One driver at a time. A second request while a handoff is open would
    // put two questions in front of one person and leave whichever they did
    // not answer waiting forever.
    if (this.state(taskId).holder !== 'agent') return 'busy'
    if (this.isUnattended(taskId)) return 'unavailable'
    if (signal.aborted) return 'cancelled'

    this.sessions.append({
      type: 'lease/requested',
      taskId,
      at: Date.now(),
      kind: request.kind,
      reason: request.reason,
      target: request.target,
    })
    this.leases.set(taskId, { holder: 'pending', since: Date.now(), reason: request.reason })

    let outcome: TakeoverOutcome
    try {
      outcome = await this.handler(
        request,
        () => this.leases.set(taskId, { holder: 'human', since: Date.now(), reason: request.reason }),
        signal,
      )
    } catch {
      // A handler that throws must not leave the lease held: the task would
      // then refuse every later handoff for a person who has long gone.
      outcome = 'failed'
    } finally {
      // Deleted rather than set back to `agent`, which `state()` already
      // reports by default. A map that only ever grows would hold an entry
      // per task for the life of the process.
      this.leases.delete(taskId)
    }

    this.sessions.append({ type: 'lease/returned', taskId, at: Date.now(), outcome })
    return outcome
  }
}

/** What the model is told, in place of anything the person typed. */
export function describeOutcome(outcome: TakeoverOutcome, request: TakeoverRequest): string {
  const what = request.kind === 'login' ? `signing in${request.target ? ` to ${request.target}` : ''}` : 'taking over'
  switch (outcome) {
    case 'completed':
      return `A person finished ${what} and handed control back. Carry on, and do not ask for any credentials — you were never given them.`
    case 'declined':
      return `A person declined ${what}. Continue without it, or stop and explain what you cannot do.`
    case 'cancelled':
      return `The request to hand over for ${what} was cancelled before anyone answered.`
    case 'unavailable':
      return `Nobody is watching this task, so ${what} cannot be handed to a person. Continue without it.`
    case 'busy':
      return `Control has already been handed to a person for something else. Wait for that to finish.`
    case 'failed':
      return `Handing over for ${what} failed. Continue without it.`
  }
}
