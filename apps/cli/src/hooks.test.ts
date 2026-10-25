import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@open-agent/agent'
import { createHookRunner, loadHooks, type HookDefinition } from './hooks.js'

let tmp: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-hooks-')))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('loadHooks', () => {
  const write = (content: unknown) => {
    const file = path.join(tmp, 'config', 'hooks.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
    return file
  }

  it('reads hooks, with a default timeout', () => {
    const file = write({
      hooks: [
        { event: 'pre_tool_call', tools: ['run_command', 'browser_*'], command: 'guard.sh', timeout_ms: 500 },
        { event: 'session_start', command: 'echo hi' },
      ],
    })

    expect(loadHooks(file, [])).toEqual({
      ok: true,
      hooks: [
        { event: 'pre_tool_call', tools: ['run_command', 'browser_*'], command: 'guard.sh', timeoutMs: 500 },
        { event: 'session_start', command: 'echo hi', timeoutMs: 10_000 },
      ],
    })
  })

  it('treats a missing file as no hooks', () => {
    expect(loadHooks(path.join(tmp, 'nope.json'), [])).toEqual({ ok: true, hooks: [] })
  })

  it.each([
    ['not JSON', '{', /not valid JSON/],
    ['no list', { hooks: 'x' }, /needs a "hooks" list/],
    ['an unknown event', { hooks: [{ event: 'on_boot', command: 'x' }] }, /"event" must be one of/],
    ['no command', { hooks: [{ event: 'session_stop' }] }, /needs a "command"/],
    ['tools on a session hook', { hooks: [{ event: 'session_stop', command: 'x', tools: ['a'] }] }, /only applies/],
    ['a bad timeout', { hooks: [{ event: 'session_stop', command: 'x', timeout_ms: 0 }] }, /timeout_ms/],
    [
      'an unknown field',
      { hooks: [{ event: 'session_stop', command: 'x', allow: true }] },
      /unsupported fields: allow/,
    ],
  ])('refuses %s', (_, content, error) => {
    expect(loadHooks(write(content), [])).toMatchObject({ ok: false, error: expect.stringMatching(error) })
  })

  it('refuses a hooks file inside a workspace the agent can write to', () => {
    const file = write({ hooks: [] })

    expect(loadHooks(file, [tmp])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/inside the agent's workspace/),
    })
    expect(loadHooks(file, [path.join(tmp, 'elsewhere')]).ok).toBe(true)
  })
})

describe('createHookRunner', () => {
  const tool = { name: 'run_command', permissionLevel: 'ask' } as ToolDefinition
  const call = { id: 'c1', name: 'run_command', args: { command: 'ls' } }
  const runner = (hooks: Array<Partial<HookDefinition> & Pick<HookDefinition, 'event' | 'command'>>) => {
    const notices: string[] = []
    const made = createHookRunner({
      hooks: hooks.map((hook) => ({ timeoutMs: 5_000, ...hook })),
      cwd: tmp,
      env: { PATH: process.env.PATH },
      notice: (text) => notices.push(text),
    })
    return { ...made, notices }
  }
  const before = (r: ReturnType<typeof runner>) => r.toolHooks.beforeCall!(call, tool, 't1')

  it('lets a call through on exit 0, and blocks it on exit 2 with the reason from stderr', async () => {
    expect(await before(runner([{ event: 'pre_tool_call', command: 'exit 0' }]))).toBeUndefined()
    expect(await before(runner([{ event: 'pre_tool_call', command: 'echo "not on Fridays" >&2; exit 2' }]))).toEqual({
      block: 'not on Fridays',
    })
  })

  it.each([
    ['crashes', 'exit 1', /exited with 1/],
    ['cannot start', 'definitely-not-a-command-here', /exited with 127/],
    ['times out', 'sleep 5', /timed out after 100 ms/],
  ])('blocks a call when the guard %s, since a broken guard is not a yes', async (_, command, reason) => {
    const result = await before(runner([{ event: 'pre_tool_call', command, timeoutMs: 100 }]))

    expect(result?.block).toMatch(/hook failed, so the call is refused/)
    expect(result?.block).toMatch(reason)
  })

  it('runs only the hooks whose tools match, prefixes included', async () => {
    const r = runner([
      { event: 'pre_tool_call', tools: ['browser_*'], command: 'exit 2' },
      { event: 'pre_tool_call', tools: ['run_*'], command: 'echo matched >&2; exit 2' },
    ])

    expect(await before(r)).toEqual({ block: 'matched' })
  })

  it('hands each hook the call as JSON on stdin, and the event in the environment', async () => {
    const out = path.join(tmp, 'seen.json')
    const r = runner([
      { event: 'pre_tool_call', command: `cat > "${out}"` },
      { event: 'post_tool_call', command: `cat > "${out}.post"; echo "$OPEN_AGENT_HOOK_EVENT" > "${out}.event"` },
    ])

    await before(r)
    await r.toolHooks.afterCall!(call, tool, { ok: true, content: 'a\nb' }, 't1')

    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual({
      event: 'pre_tool_call',
      tool: 'run_command',
      args: { command: 'ls' },
      permission_level: 'ask',
      task_id: 't1',
      cwd: tmp,
    })
    expect(JSON.parse(fs.readFileSync(`${out}.post`, 'utf8'))).toMatchObject({
      event: 'post_tool_call',
      result: { ok: true, content: 'a\nb' },
    })
    expect(fs.readFileSync(`${out}.event`, 'utf8').trim()).toBe('post_tool_call')
  })

  it('reports an observing hook that fails, and carries on', async () => {
    const r = runner([
      { event: 'session_start', command: 'echo broken >&2; exit 3' },
      { event: 'session_start', command: `echo ran > "${path.join(tmp, 'second')}"` },
    ])

    await r.session('session_start', { mode: 'repl' })

    expect(r.notices).toEqual([expect.stringMatching(/session_start hook failed: exited with 3: broken/)])
    expect(fs.existsSync(path.join(tmp, 'second'))).toBe(true)
  })
})
