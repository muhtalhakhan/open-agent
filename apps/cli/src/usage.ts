import type { TokenUsage } from '@open-agent/agent'

const count = new Intl.NumberFormat('en-US')

/**
 * `1,250 tokens in (1,000 cached) · 15 out` — input first, since it is
 * usually most of the bill: every step re-sends the whole conversation.
 */
export function formatUsage(usage: TokenUsage): string {
  const cached = usage.cachedInputTokens ? ` (${count.format(usage.cachedInputTokens)} cached)` : ''
  return `${count.format(usage.inputTokens)} tokens in${cached} · ${count.format(usage.outputTokens)} out`
}
