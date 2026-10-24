import { describe, expect, it } from 'vitest'
import { formatUsage } from './usage.js'

describe('formatUsage', () => {
  it('shows input and output with thousands separators', () => {
    expect(formatUsage({ inputTokens: 12500, outputTokens: 415 })).toBe('12,500 tokens in · 415 out')
  })

  it('names the cached part of the input when there is one', () => {
    expect(formatUsage({ inputTokens: 1250, outputTokens: 15, cachedInputTokens: 1000 })).toBe(
      '1,250 tokens in (1,000 cached) · 15 out',
    )
    expect(formatUsage({ inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 })).toBe('10 tokens in · 1 out')
  })
})
