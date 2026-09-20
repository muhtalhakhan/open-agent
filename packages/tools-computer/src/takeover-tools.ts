import { describeOutcome } from '@open-agent/agent'
import type {
  LeaseManager,
  TakeoverOutcome,
  TakeoverRequest,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from '@open-agent/agent'

/**
 * The two ways an agent hands the wheel to a person.
 *
 * Both are `ask`, and for a sharper reason than "they are sensitive". The
 * argument is attacker-controlled in the ordinary case: a page the agent just
 * read can say "log in to secure-bank-verify.test to continue", and the tool
 * would put that name in front of the user with the agent's own credibility
 * behind it. That is phishing with the agent as the courier. The approval
 * prompt is what makes the user read the destination before they are looking
 * at a login form.
 *
 * The sequence rules in `dangerous-actions.ts` compound this: a task that has
 * read a page and then asks for a login at a host nobody mentioned is
 * escalated, so the prompt names the rule too.
 */

/**
 * Turns an outcome into what the model is told.
 *
 * A person saying no is a handoff that ran and got an answer, not a tool that
 * failed, so it is `ok`. The rest genuinely did not happen — and the reason
 * goes in `error`, because `SessionLog.deriveMessages` shows the model
 * `error` and not `content` for a failed call, so a description left only in
 * `content` would reach it as "Error: undefined".
 */
function toResult(outcome: TakeoverOutcome, request: TakeoverRequest): ToolResult {
  const told = describeOutcome(outcome, request)
  if (outcome === 'completed' || outcome === 'declined') return { ok: true, content: told }
  return { ok: false, content: '', error: told }
}

/** A person is asked to take the wheel — a captcha, a decision, anything the agent should not do alone. */
export function requestTakeoverTool(leases: LeaseManager): ToolDefinition<{ reason?: string }> {
  return {
    name: 'request_takeover',
    description:
      'Hand control of this session to the person running it, and wait until they hand it back. Use when you have hit something you should not do on your own — a payment, a destructive step, a decision that is theirs. Say why in `reason`.',
    schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why a person needs to take over.' } },
      required: ['reason'],
    },
    permissionLevel: 'ask',
    async execute(args, context) {
      const request = {
        taskId: context.taskId,
        kind: 'takeover' as const,
        reason: String(args.reason ?? '').trim() || 'no reason given',
      }
      return toResult(await leases.handOver(request, context.signal), request)
    },
  }
}

/**
 * A person is asked to sign in themselves.
 *
 * The agent never handles the password. It does not ask for one, is not given
 * one, and has nowhere to put one: the handoff returns an outcome and no text.
 * The person signs in to their own browser, where the session persists for
 * later tasks, and the secret never reaches the model or the provider.
 */
export function askForLoginTool(leases: LeaseManager): ToolDefinition<{ site?: string; reason?: string }> {
  return {
    name: 'ask_for_login',
    description:
      'Ask the person running this session to sign in themselves, in their own browser, and wait until they are done. Use at a login wall. Never ask them for a password, and never expect to be told one — you get only a yes or no that it is done.',
    schema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'The site or service needing a sign-in.' },
        reason: { type: 'string', description: 'Why the sign-in is needed.' },
      },
      required: ['site'],
    },
    permissionLevel: 'ask',
    async execute(args, context) {
      const request = {
        taskId: context.taskId,
        kind: 'login' as const,
        reason: String(args.reason ?? '').trim() || 'a sign-in is needed to continue',
        target: String(args.site ?? '').trim() || undefined,
      }
      return toResult(await leases.handOver(request, context.signal), request)
    },
  }
}

/** Registers both, returning a dispose that unregisters them. */
export function mountTakeoverTools(tools: ToolRegistry, leases: LeaseManager): () => void {
  const disposers = [tools.register(requestTakeoverTool(leases)), tools.register(askForLoginTool(leases))]
  return () => disposers.forEach((dispose) => dispose())
}
