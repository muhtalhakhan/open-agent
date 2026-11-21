import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createToolTool, parseCreateArgs, validateSpec, CREATE_TOOL_NAME } from './create-tool.js'
import { createToolApprovalPrompt } from './approval-prompt.js'
import type { ToolSpec } from './spec-types.js'
import type { ToolRegistry, ToolExecutionContext } from '@open-agent/agent'

const ctx: ToolExecutionContext = { taskId: 't', signal: new AbortController().signal }

function fakeRegistry() {
  const registered: string[] = []
  return {
    registered,
    register(def: { name: string }) {
      registered.push(def.name)
      return () => {}
    },
  } as unknown as ToolRegistry & { registered: string[] }
}

describe('create_tool — argument parsing and validation', () => {
  it('parses a shell spec', () => {
    const parsed = parseCreateArgs({ kind: 'shell', command: 'git log', envArgs: ['N'] })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.spec.kind).toBe('shell')
  })

  it('rejects an unknown kind', () => {
    const parsed = parseCreateArgs({ kind: 'python' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('shell')
  })

  it('rejects a shell spec that names a forbidden env arg', () => {
    const parsed = parseCreateArgs({ kind: 'shell', command: 'echo', envArgs: ['PATH'] })
    // parseCreateArgs is permissive; validateSpec catches the denylist.
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      const problem = validateSpec(parsed.spec)
      expect(problem).toMatch(/runtime directive/)
    }
  })

  it('validateSpec accepts an empty shell envArgs list', () => {
    expect(validateSpec({ kind: 'shell', command: 'echo', envArgs: [] })).toBeNull()
  })

  it('validateSpec rejects a shell spec with no command', () => {
    expect(validateSpec({ kind: 'shell', command: '  ', envArgs: [] })).toMatch(/command/)
  })

  it('validateSpec rejects an http spec without a network policy', () => {
    expect(validateSpec({ kind: 'http' } as unknown as ToolSpec)).toMatch(/network/)
  })

  it('validateSpec rejects an http default URL the policy denies', () => {
    const spec: ToolSpec = {
      kind: 'http',
      url: 'http://localhost:8080',
      network: { allowedHosts: ['example.com'], allowLocal: false },
    }
    expect(validateSpec(spec)).toBeTruthy()
  })
})

describe('create_tool — end to end', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openagent-create-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not save when the user declines', async () => {
    const registry = fakeRegistry()
    const tool = createToolTool({
      registry,
      prompt: createToolApprovalPrompt(async () => 'N'),
      saveDir: dir,
    })
    const result = await tool.execute(
      { name: 'my-tool', description: 'does a thing', kind: 'shell', command: 'echo hi', envArgs: [] },
      ctx,
    )
    expect(result.ok).toBe(false)
    expect(registry.registered).toHaveLength(0)
  })

  it('saves and registers an approved shell tool', async () => {
    const registry = fakeRegistry()
    const tool = createToolTool({
      registry,
      prompt: createToolApprovalPrompt(async () => 'y'),
      saveDir: dir,
    })
    const result = await tool.execute(
      { name: 'approved-tool', description: 'does a thing', kind: 'shell', command: 'echo hi', envArgs: [] },
      ctx,
    )
    expect(result.ok).toBe(true)
    expect(registry.registered).toContain('approved-tool')
    const written = JSON.parse(readFileSync(join(dir, 'approved-tool.json'), 'utf-8'))
    expect(written.specVersion).toBe(1)
    expect(written.spec.kind).toBe('shell')
  })

  it('saves and registers an approved HTTP tool', async () => {
    const registry = fakeRegistry()
    const tool = createToolTool({
      registry,
      prompt: createToolApprovalPrompt(async () => 'y'),
      saveDir: dir,
    })
    const result = await tool.execute(
      {
        name: 'http-tool',
        description: 'fetches a thing',
        kind: 'http',
        url: 'https://example.com',
        allowedHosts: ['example.com'],
      },
      ctx,
    )
    expect(result.ok).toBe(true)
    expect(registry.registered).toContain('http-tool')
  })

  it('rejects a non-kebab-case name before prompting', async () => {
    const registry = fakeRegistry()
    let prompted = false
    const tool = createToolTool({
      registry,
      prompt: async (_c) => {
        prompted = true
        return { approved: true }
      },
      saveDir: dir,
    })
    const result = await tool.execute(
      { name: 'Bad Name!', description: 'd', kind: 'shell', command: 'echo', envArgs: [] },
      ctx,
    )
    expect(result.ok).toBe(false)
    expect(prompted).toBe(false)
    expect((result as { error?: string }).error).toMatch(/lowercase letters/)
  })

  it('reports a name clash rather than shadowing a built-in', async () => {
    const registry = fakeRegistry()
    ;(registry as unknown as { register: (d: { name: string }) => () => void }).register = (def) => {
      if (def.name === 'run_command') throw new Error('tool "run_command" is already registered')
      registry.registered.push(def.name)
      return () => {}
    }
    const tool = createToolTool({
      registry,
      prompt: createToolApprovalPrompt(async () => 'y'),
      saveDir: dir,
    })
    const result = await tool.execute(
      { name: 'run_command', description: 'shadow', kind: 'shell', command: 'echo', envArgs: [] },
      ctx,
    )
    expect(result.ok).toBe(false)
    expect((result as { error?: string }).error).toMatch(/already registered|next run/)
  })

  it('tool is dangerous and carries the right name', () => {
    const tool = createToolTool({ registry: fakeRegistry(), prompt: createToolApprovalPrompt(async () => 'n') })
    expect(tool.name).toBe(CREATE_TOOL_NAME)
    expect(tool.permissionLevel).toBe('dangerous')
  })
})
