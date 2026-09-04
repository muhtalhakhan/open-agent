import { describe, expect, it } from 'vitest'
import { parseCliArgs } from './args.js'

/** Unwraps a parse expected to succeed, so the assertions stay readable. */
function ok(argv: string[]) {
  const result = parseCliArgs(argv)
  if (!result.ok) throw new Error(`expected a successful parse, got: ${result.error}`)
  return result.args
}

describe('parseCliArgs', () => {
  it('defaults to the interactive session with no arguments', () => {
    expect(ok([])).toEqual({ mode: 'repl', approveAsk: false, help: false })
  })

  it('takes the task inline after -p', () => {
    expect(ok(['-p', 'run the tests'])).toMatchObject({ mode: 'print', prompt: 'run the tests' })
  })

  it('accepts the long form --print', () => {
    expect(ok(['--print', 'run the tests'])).toMatchObject({ mode: 'print', prompt: 'run the tests' })
  })

  it('leaves the prompt undefined for a bare -p, meaning "read stdin"', () => {
    expect(ok(['-p'])).toMatchObject({ mode: 'print', prompt: undefined })
  })

  it('carries --yes through', () => {
    expect(ok(['-p', 'task', '--yes']).approveAsk).toBe(true)
    expect(ok(['-p', 'task', '-y']).approveAsk).toBe(true)
    expect(ok(['-p', 'task']).approveAsk).toBe(false)
  })

  it('recognises --help before anything else', () => {
    expect(ok(['--help']).help).toBe(true)
    expect(ok(['-h']).help).toBe(true)
  })

  it('suggests -p when a bare task is passed without it', () => {
    const result = parseCliArgs(['summarize the tests'])

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('-p "summarize the tests"')
  })

  it('rejects a task split across several arguments, which would silently drop words', () => {
    const result = parseCliArgs(['-p', 'run', 'the', 'tests'])

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('single argument')
  })

  it('reports an unknown flag with the usage text', () => {
    const result = parseCliArgs(['--nope'])

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Usage')
  })
})
