import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadSavedTool, loadUserTools, registerUserTool, mountUserBuiltTools, USER_TOOLS_DIR } from './loader.js'
import type { ToolSpec } from './spec-types.js'
import type { ToolRegistry } from '@open-agent/agent'

/** A registry double that records registrations and can be told which names are taken. */
function fakeRegistry(existing: string[] = []) {
  const registered: Array<{ name: string; permissionLevel: string }> = []
  const taken = new Set(existing)
  return {
    registered,
    register(def: { name: string; permissionLevel: string }) {
      if (taken.has(def.name)) throw new Error(`name taken: ${def.name}`)
      taken.add(def.name)
      registered.push({ name: def.name, permissionLevel: def.permissionLevel })
      return () => taken.delete(def.name)
    },
  } as unknown as ToolRegistry & { registered: Array<{ name: string; permissionLevel: string }> }
}

/** Write a valid specVersion-1 saved tool file. */
function writeTool(dir: string, name: string, spec: ToolSpec) {
  const file = { specVersion: 1, spec, approvedAt: new Date().toISOString(), note: 'test' }
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(file, null, 2), 'utf-8')
}

describe('tool-builder loader — security invariants', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openagent-tools-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('USER_TOOLS_DIR lives under the user home, never a system path', () => {
    expect(USER_TOOLS_DIR).toContain('.openagent')
    expect(USER_TOOLS_DIR).toContain('tools')
    const normalized = USER_TOOLS_DIR.replace(/\\/g, '/').toLowerCase()
    expect(normalized).not.toContain('/etc/')
    expect(normalized).not.toContain('/usr/')
    expect(normalized).not.toContain('/var/')
    expect(normalized).not.toContain('program files')
  })

  it('loadSavedTool rejects a non-version-1 file', async () => {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ specVersion: 99, spec: {}, approvedAt: '' }), 'utf-8')
    expect(await loadSavedTool(bad)).toBeNull()
  })

  it('loadSavedTool rejects a spec with an unknown kind', async () => {
    const bad = join(dir, 'kind.json')
    writeFileSync(bad, JSON.stringify({ specVersion: 1, spec: { kind: 'python' }, approvedAt: '' }), 'utf-8')
    expect(await loadSavedTool(bad)).toBeNull()
  })

  it('loadSavedTool rejects unparseable JSON', async () => {
    const bad = join(dir, 'junk.json')
    writeFileSync(bad, '{not json', 'utf-8')
    expect(await loadSavedTool(bad)).toBeNull()
  })

  it('loadUserTools skips symlinks and reports them', async () => {
    writeTool(dir, 'good', { kind: 'shell', command: 'echo hi', envArgs: [] })
    const linkPath = join(dir, 'evil.json')
    const target = join(dir, 'outside.json')
    writeFileSync(
      target,
      JSON.stringify({ specVersion: 1, spec: { kind: 'shell', command: 'rm -rf /', envArgs: [] } }),
      'utf-8',
    )
    try {
      symlinkSync(target, linkPath)
    } catch {
      return // symlinks unavailable on this runner
    }
    const reported: string[] = []
    const loaded = await loadUserTools((m) => reported.push(m), dir)
    const names = loaded.map((l) => l.name)
    expect(names).toContain('good')
    expect(names).not.toContain('evil')
    expect(reported.join('\n')).toContain('not a regular file')
  })

  it('loadUserTools skips directories named *.json', async () => {
    mkdirSync(join(dir, 'sub.json'), { recursive: true })
    writeTool(dir, 'ok', { kind: 'shell', command: 'echo hi', envArgs: [] })
    const loaded = await loadUserTools(() => {}, dir)
    const names = loaded.map((l) => l.name)
    expect(names).toContain('ok')
    expect(names).not.toContain('sub')
  })

  it('loadUserTools returns [] when the folder does not exist', async () => {
    const missing = join(dir, 'does-not-exist')
    const loaded = await loadUserTools(() => {}, missing)
    expect(loaded).toEqual([])
  })

  it('registerUserTool refuses to shadow a built-in name and reports the clash', () => {
    const registry = fakeRegistry(['run_command'])
    const loaded = { name: 'run_command', spec: { kind: 'shell' as const, command: 'echo', envArgs: [] } as ToolSpec }
    expect(() => registerUserTool(registry, loaded)).toThrow(/run_command/)
  })

  it('registerUserTool always produces a dangerous-level definition', () => {
    const registry = fakeRegistry()
    registerUserTool(registry, { name: 'my_tool', spec: { kind: 'shell', command: 'echo', envArgs: [] } })
    expect(registry.registered[0].permissionLevel).toBe('dangerous')
  })

  it('registerUserTool produces a dangerous HTTP tool too', () => {
    const registry = fakeRegistry()
    registerUserTool(registry, { name: 'http_tool', spec: { kind: 'http', network: {} } })
    expect(registry.registered[0].permissionLevel).toBe('dangerous')
  })

  it('mountUserBuiltTools isolates a bad file from a good one', async () => {
    writeTool(dir, 'good', { kind: 'shell', command: 'echo', envArgs: [] })
    // A tool whose name collides with an already-registered built-in.
    writeTool(dir, 'taken', { kind: 'shell', command: 'echo', envArgs: [] })
    const registry = fakeRegistry(['taken'])
    const reported: string[] = []
    await mountUserBuiltTools(registry, { report: (m) => reported.push(m), dir })
    const names = registry.registered.map((r) => r.name)
    expect(names).toContain('good')
    expect(names).not.toContain('taken')
  })
})
