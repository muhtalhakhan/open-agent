import { describe, expect, it } from 'vitest'
import { DEFAULT_WEB_PORT, parseCliArgs } from './args.js'

/** Unwraps a parse expected to succeed, so the assertions stay readable. */
function ok(argv: string[]) {
  const result = parseCliArgs(argv)
  if (!result.ok) throw new Error(`expected a successful parse, got: ${result.error}`)
  return result.args
}

describe('parseCliArgs', () => {
  it('defaults to the interactive session with no arguments', () => {
    expect(ok([])).toEqual({ mode: 'repl', approveAsk: false, plan: false, history: false, help: false })
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

  it('carries --profile through to the session, print mode and web', () => {
    expect(ok(['--profile', 'coding-agent']).profile).toBe('coding-agent')
    expect(ok(['-p', 'task', '--profile', './p.yaml']).profile).toBe('./p.yaml')
    expect(ok(['web', '--profile', 'research-agent']).profile).toBe('research-agent')
    expect(ok([])).not.toHaveProperty('profile')
  })

  it('rejects an empty --profile', () => {
    expect(parseCliArgs(['--profile', ''])).toMatchObject({ ok: false, error: expect.stringMatching(/--profile/) })
  })

  it('runs the setup wizard for "init", and treats -p init as a task', () => {
    expect(ok(['init'])).toMatchObject({ mode: 'init' })
    expect(ok(['-p', 'init'])).toMatchObject({ mode: 'print', prompt: 'init' })
  })

  it('serves the web UI for "web", on the default port unless --port says otherwise', () => {
    expect(ok(['web'])).toMatchObject({ mode: 'web', port: DEFAULT_WEB_PORT, approveAsk: false })
    expect(ok(['web', '--port', '8080'])).toMatchObject({ mode: 'web', port: 8080 })
    expect(ok(['web', '--yes']).approveAsk).toBe(true)
    expect(ok(['-p', 'web'])).toMatchObject({ mode: 'print', prompt: 'web' })
  })

  it('rejects a port that is not one, and --port without "web"', () => {
    for (const port of ['0', '65536', 'abc', '80.5', '']) {
      const result = parseCliArgs(['web', '--port', port])
      expect(result.ok, port).toBe(false)
    }
    const stray = parseCliArgs(['--port', '8080'])
    expect(stray.ok).toBe(false)
    if (!stray.ok) expect(stray.error).toContain('open-agent web')
  })

  it('turns plan mode on with --plan', () => {
    expect(ok(['--plan'])).toMatchObject({ mode: 'repl', plan: true })
    expect(ok(['--plan']).plan).toBe(true)
    expect(ok([]).plan).toBe(false)
    expect(ok(['-p', 'task', '--plan']).plan).toBe(true)
  })

  it('recognises --help before anything else', () => {
    expect(ok(['--help']).help).toBe(true)
    expect(ok(['-h']).help).toBe(true)
  })

  it('recognises --history, which needs no task', () => {
    expect(ok(['--history']).history).toBe(true)
    expect(ok([]).history).toBe(false)
    expect(ok(['-p', 'task']).history).toBe(false)
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
