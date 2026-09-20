import type { TakeoverHandler, TakeoverOutcome, TakeoverRequest } from '@open-agent/agent'

/**
 * The terminal end of a control handoff (#50).
 *
 * Two questions, not one. The first asks whether to hand over at all and
 * names what the agent wants — a login prompt for a site chosen by a page the
 * agent just read is a phishing attempt wearing the agent's credibility, and
 * the only defence is that the person reads the name before they are looking
 * at a sign-in form. The second waits, because the agent must not act while
 * someone else is driving.
 *
 * Nothing the person types is read back. The second question accepts only
 * "done" or "cancel", and neither the answer nor anything else typed during
 * the handoff is returned, logged, or shown to the model. A password typed at
 * the wrong moment has nowhere to go. See docs/security-model.md.
 */

/** What the person is asked, given the agent's stated reason. */
export function describeRequest(request: TakeoverRequest): string {
  const headline =
    request.kind === 'login'
      ? `The agent is asking you to sign in${request.target ? ` to ${request.target}` : ''} yourself.`
      : 'The agent is asking you to take over.'
  return (
    `\n🤝 ${headline}\n` +
    `  Reason: ${request.reason}\n` +
    (request.kind === 'login'
      ? '  Sign in in your own browser. Do not type any password here — the agent never sees it.\n'
      : '  The agent will not act until you hand control back.\n')
  )
}

export function createTerminalTakeoverHandler(ask: (question: string) => Promise<string>): TakeoverHandler {
  return async (request, grant, signal): Promise<TakeoverOutcome> => {
    if (signal.aborted) return 'cancelled'

    const accepted = (await ask(`${describeRequest(request)}  Hand over now? [y]es / [N]o `)).trim().toLowerCase()
    if (!accepted.startsWith('y')) return 'declined'

    // Control is genuinely theirs from here, so the lease says so.
    grant()
    if (signal.aborted) return 'cancelled'

    const finished = (await ask('  Press Enter when you are done, or type "cancel": ')).trim().toLowerCase()
    if (signal.aborted) return 'cancelled'
    return finished.startsWith('c') ? 'declined' : 'completed'
  }
}
