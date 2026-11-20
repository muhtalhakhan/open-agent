import { describe, it, expect } from 'vitest'
import { buildShellTool, checkEnvArgName, buildHttpTool } from './builder.js'
import { approveAndSaveTool, saveApprovedTool } from './approval-flow.js'
import { createToolApprovalPrompt } from './approval-prompt.js'
import type { ToolSpec } from './spec-types.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('tool-builder — env-arg denylist', () => {
  const forbidden = ['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'PYTHONPATH', 'IFS', 'PSModulePath']
  for (const name of forbidden) {
    it(`refuses ${name} as an env arg`, () => {
      expect(() => checkEnvArgName(name)).toThrow(/runtime directive/)
    })
  }

  it('allows an ordinary argument name', () => {
    expect(() => checkEnvArgName('MSG')).not.toThrow()
    expect(() => checkEnvArgName('FILE')).not.toThrow()
  })

  it('buildShellTool throws at build time when a spec names a forbidden env arg', () => {
    const spec = { kind: 'shell' as const, command: 'echo $PATH', envArgs: ['MSG', 'PATH'] }
    expect(() => buildShellTool(spec)).toThrow(/runtime directive/)
  })

  it('case-insensitive denylist', () => {
    expect(() => checkEnvArgName('path')).toThrow()
    expect(() => checkEnvArgName('Path')).toThrow()
  })

  it('shellSchema lists each env arg as a required string property', () => {
    const tool = buildShellTool({ kind: 'shell', command: 'echo', envArgs: ['A', 'B'] })
    const schema = tool.schema as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties).sort()).toEqual(['A', 'B'])
    expect(schema.required.sort()).toEqual(['A', 'B'])
  })
})

describe('tool-builder — approval flow', () => {
  it('approveAndSaveTool refuses to write when the user declines', async () => {
    const prompt = createToolApprovalPrompt(async () => 'N')
    const spec: ToolSpec = { kind: 'shell', command: 'echo hi', envArgs: [] }
    const result = await approveAndSaveTool(prompt, 'declined', 'a tool', spec)
    expect(result.saved).toBe(false)
    expect(result.path).toBeUndefined()
  })

  it('approveAndSaveTool writes an approved spec to the user tools folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openagent-save-'))
    try {
      // saveApprovedTool uses the module-level USER_TOOLS_DIR; verify it writes a
      // specVersion-1 file and returns the path rather than asserting the exact
      // home path (which depends on the runner's HOME).
      const name = `saved_${Date.now()}`
      const path = await saveApprovedTool(name, 'test tool', {
        kind: 'shell',
        command: 'echo hi',
        envArgs: [],
      })
      expect(path).toContain(`${name}.json`)
      const written = JSON.parse(readFileSync(path, 'utf-8'))
      expect(written.specVersion).toBe(1)
      expect(written.spec.kind).toBe('shell')
      expect(written.approvedAt).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('approveAndSaveTool round-trips through the prompt and returns saved path', async () => {
    const prompt = createToolApprovalPrompt(async () => 'y')
    const spec: ToolSpec = { kind: 'http', network: { allowedHosts: ['example.com'] } }
    const result = await approveAndSaveTool(prompt, `roundtrip_${Date.now()}`, 'http tool', spec)
    expect(result.saved).toBe(true)
    expect(result.path).toContain('.json')
  })

  it('built tools never report a safe permission level', () => {
    const shell = buildShellTool({ kind: 'shell', command: 'echo', envArgs: [] })
    const http = buildHttpTool({ kind: 'http', network: {} })
    expect(shell.permissionLevel).toBe('dangerous')
    expect(http.permissionLevel).toBe('dangerous')
  })
})
