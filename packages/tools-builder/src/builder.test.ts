import { describe, it, expect } from 'vitest'
import { buildShellTool, buildHttpTool, convertNetworkSpec } from './builder.js'
import { USER_TOOLS_DIR } from './loader.js'
import { createToolApprovalPrompt } from './approval-prompt.js'

describe('tool-builder', () => {
  it('produces a dangerous-level shell tool', () => {
    const spec = {
      kind: 'shell' as const,
      command: 'echo $MSG',
      envArgs: ['MSG'],
      allowedCommands: ['echo'],
    }
    const tool = buildShellTool(spec)
    expect(tool.permissionLevel).toBe('dangerous')
    expect(tool.name).toBe('built_shell_tool')
    expect((tool.schema as any).properties.MSG).toBeDefined()
  })

  it('produces a dangerous-level HTTP tool with network policy', () => {
    const spec = {
      kind: 'http' as const,
      network: { allowedHosts: ['api.example.com'], deniedHosts: ['evil.com'], allowLocal: false },
    }
    const tool = buildHttpTool(spec)
    expect(tool.permissionLevel).toBe('dangerous')
    expect((tool.schema as any).properties.url).toBeDefined()
  })

  it('converts network spec', () => {
    const net = convertNetworkSpec({ allowedHosts: ['x'], deniedHosts: ['y'], allowLocal: true })
    expect(net.allowedHosts).toEqual(['x'])
    expect(net.allowLocal).toBe(true)
  })

  it('approval prompt requires approval', async () => {
    const ask = async (q: string) => (q.includes('y') ? 'y' : 'N')
    const prompt = createToolApprovalPrompt(ask)
    const result = await prompt({ toolName: 't', description: 'd', specJson: '{}', storagePath: '/x.json' })
    expect(result.approved).toBe(true)
  })

  it('user tools folder points to home', () => {
    expect(USER_TOOLS_DIR).toContain('.openagent')
    expect(USER_TOOLS_DIR).toContain('tools')
  })
})
