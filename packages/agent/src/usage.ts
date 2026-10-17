import type { SessionEvent, TokenUsage } from './types.js'

/**
 * What a run of events cost in tokens: every model reply among them, summed.
 *
 * `undefined` when none reported usage. A provider that does not say is not
 * one that charged nothing, and a zero would read as the second. Requests
 * that failed and were retried are not counted: only replies that made it
 * into the log carry usage, so this is a floor on what was billed.
 */
export function totalUsage(events: Iterable<SessionEvent>): TokenUsage | undefined {
  let total: TokenUsage | undefined
  for (const event of events) {
    if (event.type !== 'assistant/message' || !event.usage) continue
    const { inputTokens, outputTokens, cachedInputTokens } = event.usage
    total ??= { inputTokens: 0, outputTokens: 0 }
    total.inputTokens += inputTokens
    total.outputTokens += outputTokens
    if (cachedInputTokens !== undefined) total.cachedInputTokens = (total.cachedInputTokens ?? 0) + cachedInputTokens
  }
  return total
}
