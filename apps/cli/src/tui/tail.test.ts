import { describe, expect, it } from 'vitest'
import stringWidth from 'string-width'
import { tail } from './tail.js'

const bold = (s: string) => `\u001B[1m${s}\u001B[22m`
const cyan = (s: string) => `\u001B[36m${s}\u001B[39m`

describe('tail', () => {
  it('returns text that fits unchanged', () => {
    expect(tail('a\nb\nc', 3, 80)).toBe('a\nb\nc')
  })

  it('keeps the last lines when there are more than rows', () => {
    expect(tail('1\n2\n3\n4\n5', 3, 80)).toBe('…\n4\n5')
  })

  it('counts a long plain line as the rows it wraps onto', () => {
    // 15 columns wrap onto 2 rows at 10, so with 3 rows only it and the marker fit.
    const long = 'x'.repeat(15)
    expect(tail(`a\nb\n${long}`, 3, 10)).toBe(`…\n${long}`)
    expect(tail(`a\nb\n${long}`, 4, 10)).toBe(`a\nb\n${long}`)
  })

  it('does not count ANSI codes as columns', () => {
    // 36 visible columns; the raw string is longer than 40.
    const line = `Use ${bold('boldboldbold')} and ${cyan('code')} then xxxxx`
    expect(line.length).toBeGreaterThan(40)
    expect(tail(line, 1, 40)).toBe(line)
  })

  it('counts wide characters as two columns', () => {
    const wide = '漢'.repeat(6) // 12 columns
    expect(tail(`a\nb\n${wide}`, 3, 10)).toBe(`…\n${wide}`)
    expect(tail(`a\nb\n${wide}`, 4, 10)).toBe(`a\nb\n${wide}`)
  })

  it('cuts a single over-tall line from its start without breaking escape codes', () => {
    const line = cyan('y'.repeat(50))
    const out = tail(line, 3, 10)
    const [marker, kept] = out.split('\n')
    expect(marker).toBe('…')
    expect(stringWidth(kept)).toBeLessThanOrEqual(20)
    // The colour is still closed, so nothing after it inherits it.
    expect(kept.endsWith('\u001B[39m')).toBe(true)
  })
})
