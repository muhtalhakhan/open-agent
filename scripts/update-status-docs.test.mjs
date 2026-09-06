import { describe, expect, it } from 'vitest'
import {
  assertIssuesResolved,
  describeState,
  renderMilestoneTable,
  replaceGeneratedBlock,
} from './update-status-docs.mjs'

const milestone = (overrides) => ({ title: 'Milestone 1 — Thing', closed: 0, open: 0, remaining: [], ...overrides })
const issues = (...numbers) => numbers.map((number) => ({ number, title: `issue ${number}` }))

describe('describeState', () => {
  it('calls a milestone with nothing open complete', () => {
    expect(describeState(milestone({ closed: 10 }))).toBe('✅ Complete')
  })

  it('distinguishes not started from in progress', () => {
    expect(describeState(milestone({ open: 8, remaining: issues(1) }))).toBe('🚧 Not started — first up: issue 1 (#1)')
    expect(describeState(milestone({ closed: 3, open: 5, remaining: issues(1) }))).toBe(
      '🟡 In progress — issue 1 (#1) left',
    )
  })

  it('calls a milestone at 75% or better nearly done', () => {
    expect(describeState(milestone({ closed: 9, open: 1, remaining: issues(29) }))).toBe(
      '🟢 Nearly done — issue 29 (#29) left',
    )
  })

  it('lists at most two issues and counts the rest', () => {
    expect(describeState(milestone({ closed: 1, open: 5, remaining: issues(1, 2, 3, 4, 5) }))).toBe(
      '🟡 In progress — issue 1 (#1), issue 2 (#2), +3 more left',
    )
  })

  it('clips an issue title long enough to stretch the row', () => {
    const long = { number: 9, title: 'Plan mode: diff review and approval workflow, in full' }
    expect(describeState(milestone({ closed: 1, open: 1, remaining: [long] }))).toBe(
      '🟡 In progress — Plan mode: diff review and approval workflo… (#9) left',
    )
  })

  it('reports an empty milestone rather than dividing by zero', () => {
    expect(describeState(milestone({}))).toBe('⚪ No issues yet')
  })
})

describe('renderMilestoneTable', () => {
  it('orders by milestone number, not by string or API order', () => {
    const table = renderMilestoneTable([
      milestone({ title: 'Milestone 10 — Cloud', open: 8 }),
      milestone({ title: 'Milestone 2 — Providers', closed: 9, open: 1, remaining: issues(29) }),
    ])
    const names = table
      .split('\n')
      .slice(2)
      .map((row) => row.split('|')[1].trim())
    expect(names).toEqual(['2 — Providers', '10 — Cloud'])
  })

  it('drops the "Milestone" prefix and shows closed over total', () => {
    const table = renderMilestoneTable([milestone({ title: 'Milestone 5 — Files + Terminal', closed: 1, open: 9 })])
    expect(table).toContain('| 5 — Files + Terminal | 1 / 10 |')
  })

  it('escapes a pipe in an issue title so it cannot break the table', () => {
    const table = renderMilestoneTable([milestone({ closed: 1, open: 1, remaining: [{ number: 7, title: 'a | b' }] })])
    expect(table).toContain('a \\| b (#7)')
    // Markdown splits a row on unescaped pipes only, so the row is still 3 cells.
    expect(table.split('\n')[2].split(/(?<!\\)\|/)).toHaveLength(5)
  })
})

describe('assertIssuesResolved', () => {
  it('rejects a milestone with open issues but no issue list', () => {
    expect(() => assertIssuesResolved([milestone({ title: 'Milestone 9 — Security', closed: 3, open: 6 })])).toThrow(
      /Milestone 9 — Security.*issues:read/s,
    )
  })

  it('accepts a complete milestone, which has nothing left to list', () => {
    expect(() => assertIssuesResolved([milestone({ closed: 10 })])).not.toThrow()
  })

  it('accepts a milestone whose open issues came back', () => {
    expect(() => assertIssuesResolved([milestone({ closed: 1, open: 1, remaining: issues(52) })])).not.toThrow()
  })
})

describe('replaceGeneratedBlock', () => {
  const wrap = (body) =>
    `intro\n\n<!-- BEGIN GENERATED: milestone-status -->\n\n${body}\n\n<!-- END GENERATED: milestone-status -->\n\noutro\n`

  it('replaces only the marked block', () => {
    expect(replaceGeneratedBlock(wrap('old'), 'new')).toBe(wrap('new'))
  })

  it('is idempotent', () => {
    const once = replaceGeneratedBlock(wrap('old'), 'new')
    expect(replaceGeneratedBlock(once, 'new')).toBe(once)
  })

  it('refuses a file with no markers rather than guessing where the table goes', () => {
    expect(() => replaceGeneratedBlock('# README\n', 'new')).toThrow(/missing the/)
  })
})
