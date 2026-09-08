import { describe, expect, it } from 'vitest'
import { atTrigger, cronTrigger, everyTrigger } from './triggers.js'

describe('everyTrigger', () => {
  it('measures the interval from the previous fire when unanchored', () => {
    expect(everyTrigger({ kind: 'every', everyMs: 1_000 }, 5_000)).toBe(6_000)
    expect(everyTrigger({ kind: 'every', everyMs: 1_000 }, 5_500)).toBe(6_500)
  })

  it('pins occurrences to the anchor grid when anchored', () => {
    const spec = { kind: 'every', everyMs: 1_000, anchor: 0 }
    // Mid-interval, so the next grid point rather than "now plus an interval".
    expect(everyTrigger(spec, 5_500)).toBe(6_000)
    // Exactly on a grid point yields the following one, never the same instant.
    expect(everyTrigger(spec, 6_000)).toBe(7_000)
  })

  it('waits for an anchor that is still ahead', () => {
    expect(everyTrigger({ kind: 'every', everyMs: 1_000, anchor: 9_000 }, 5_000)).toBe(9_000)
  })

  it('stops at the until bound', () => {
    const spec = { kind: 'every', everyMs: 1_000, until: 7_000 }
    expect(everyTrigger(spec, 5_000)).toBe(6_000)
    expect(everyTrigger(spec, 6_000)).toBe(7_000)
    expect(everyTrigger(spec, 7_000)).toBeUndefined()
  })

  it.each([
    [{ kind: 'every' }, /positive `everyMs`/],
    [{ kind: 'every', everyMs: 0 }, /positive `everyMs`/],
    [{ kind: 'every', everyMs: -5 }, /positive `everyMs`/],
    [{ kind: 'every', everyMs: 1_000, anchor: 'soon' }, /`anchor` must be a timestamp/],
    [{ kind: 'every', everyMs: 1_000, until: 'later' }, /`until` must be a timestamp/],
  ])('rejects %j', (spec, message) => {
    expect(() => everyTrigger(spec, 0)).toThrow(message)
  })
})

describe('cronTrigger', () => {
  it('resolves the expression in the given zone', () => {
    const at = cronTrigger(
      { kind: 'cron', expr: '0 9 * * *', timeZone: 'America/New_York' },
      Date.parse('2026-09-09T20:00:00Z'),
    )
    expect(at).toBe(Date.parse('2026-09-10T13:00:00Z'))
  })

  it('stops at the until bound', () => {
    const spec = { kind: 'cron', expr: '0 * * * *', timeZone: 'UTC', until: Date.parse('2026-09-09T11:00:00Z') }
    expect(cronTrigger(spec, Date.parse('2026-09-09T10:30:00Z'))).toBe(Date.parse('2026-09-09T11:00:00Z'))
    expect(cronTrigger(spec, Date.parse('2026-09-09T11:00:00Z'))).toBeUndefined()
  })

  it('rejects a malformed expression', () => {
    expect(() => cronTrigger({ kind: 'cron', expr: 'not a cron' }, 0)).toThrow(/needs 5 fields/)
    expect(() => cronTrigger({ kind: 'cron' }, 0)).toThrow(/needs an `expr` string/)
  })

  it('reuses the parse of a repeated expression', () => {
    // Same expression twice must agree; the cache is an optimisation, not a
    // behaviour change.
    const from = Date.parse('2026-09-09T10:00:00Z')
    const spec = { kind: 'cron', expr: '*/5 * * * *', timeZone: 'UTC' }
    expect(cronTrigger(spec, from)).toBe(cronTrigger({ ...spec }, from))
  })
})

describe('atTrigger', () => {
  it('fires once and then reports no further occurrence', () => {
    expect(atTrigger({ kind: 'at', at: 5_000 }, 0, undefined)).toBe(5_000)
    expect(atTrigger({ kind: 'at', at: 5_000 }, 5_000, 5_000)).toBeUndefined()
  })

  it('rejects a missing timestamp', () => {
    expect(() => atTrigger({ kind: 'at' }, 0, undefined)).toThrow(/numeric `at` timestamp/)
  })
})
