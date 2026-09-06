import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCommandTool } from './run-command.js'

let root: string
const ctx = { taskId: 't1', signal: new AbortController().signal }

const run = (args: Record<string, unknown>, options: Record<string, unknown> = {}) =>
  runCommandTool({ root, ...options }).execute(args as never, ctx)

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-command-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('runCommandTool', () => {
  it('asks: no static level can tell ls from rm, so every call is a prompt', () => {
    expect(runCommandTool({ root }).permissionLevel).toBe('ask')
  })

  it('returns the exit code and stdout', async () => {
    const result = await run({ command: 'echo hello' })
    expect(result.ok).toBe(true)
    expect(result.content).toBe('exit code: 0\n\nstdout:\nhello')
  })

  it('reports a non-zero exit as a successful call, so the model can read the failure', async () => {
    const result = await run({ command: 'exit 3' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('exit code: 3')
  })

  it('captures stderr separately from stdout', async () => {
    const result = await run({ command: 'echo out; echo err 1>&2' })
    expect(result.content).toContain('stdout:\nout')
    expect(result.content).toContain('stderr:\nerr')
  })

  it('says so when a command produced no output at all', async () => {
    expect((await run({ command: 'true' })).content).toBe('exit code: 0\n\n(no output)')
  })

  it('runs in the workspace root by default', async () => {
    await fs.writeFile(path.join(root, 'marker.txt'), '')
    expect((await run({ command: 'ls' })).content).toContain('marker.txt')
  })

  it('runs in a subdirectory when given one', async () => {
    await fs.mkdir(path.join(root, 'sub'))
    await fs.writeFile(path.join(root, 'sub', 'inner.txt'), '')
    expect((await run({ command: 'ls', cwd: 'sub' })).content).toContain('inner.txt')
  })

  it.each([
    ['a traversal above the root', '..'],
    ['an absolute path outside the root', '/etc'],
  ])('refuses to run in %s', async (_label, cwd) => {
    const result = await run({ command: 'ls', cwd })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('outside the workspace root')
  })

  it('reports a missing cwd by the path the model wrote', async () => {
    expect((await run({ command: 'ls', cwd: 'nope' })).error).toBe('no such directory: "nope"')
  })

  it('refuses a destructive command before spawning anything', async () => {
    const result = await run({ command: 'rm -rf /' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('recursive delete')
  })

  it('enforces a configured command allowlist', async () => {
    const result = await run({ command: 'curl example.test' }, { allowedCommands: ['echo'] })
    expect(result.error).toContain('not in the allowed command list')
  })

  it('kills a command that runs past the timeout', async () => {
    const result = await run({ command: 'sleep 30' }, { timeoutMs: 300 })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('timed out after 300ms')
  })

  it('kills the whole process group, not just the shell', async () => {
    // `sleep` here is a grandchild of the shell: killing only the shell would
    // leave it running and the pipe open, and this call would never return.
    const result = await run({ command: 'sleep 30 | cat' }, { timeoutMs: 300 })
    expect(result.content).toContain('timed out')
  })

  it('lets a per-call timeout override the configured one', async () => {
    const result = await run({ command: 'sleep 30', timeout_ms: 250 }, { timeoutMs: 60_000 })
    expect(result.content).toContain('timed out after 250ms')
  })

  it('rejects a nonsense timeout', async () => {
    expect((await run({ command: 'true', timeout_ms: 0 })).error).toBe('timeout_ms must be a positive integer')
  })

  it('stops a command when the task is cancelled', async () => {
    const controller = new AbortController()
    const pending = runCommandTool({ root }).execute({ command: 'sleep 30' }, {
      taskId: 't1',
      signal: controller.signal,
    } as never)
    controller.abort()
    const result = await pending
    expect(result.content).toContain('[cancelled]')
  })

  it('truncates output at the byte ceiling instead of hanging on a full pipe', async () => {
    const result = await run({ command: 'yes hello | head -c 100000' }, { maxOutputBytes: 500 })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('[output was truncated at the byte ceiling]')
    expect(result.content.length).toBeLessThan(2_000)
  })

  it('hides credential-looking variables from the command', async () => {
    const result = await run({ command: 'echo "key=$OPENAI_API_KEY end"' }, { env: { OPENAI_API_KEY: 'sk-live-1' } })
    expect(result.content).not.toContain('sk-live-1')
    expect(result.content).toContain('key= end')
  })

  it('passes through the variables the operator allowed', async () => {
    const result = await run(
      { command: 'echo "$GH_TOKEN"' },
      { env: { GH_TOKEN: 'ghp-allowed' }, allowEnv: ['GH_TOKEN'] },
    )
    expect(result.content).toContain('ghp-allowed')
  })

  it('rejects a missing command', async () => {
    expect((await run({})).error).toBe('command is required')
  })
})
