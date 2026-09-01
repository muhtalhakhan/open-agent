import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnMcpServer } from './spawn.js'
import { mcpToolDefinition } from './tool-adapter.js'
import type { McpStdioClient } from './client.js'

const fixture = fileURLToPath(new URL('../test-fixtures/fake-mcp-server.mjs', import.meta.url))

describe('McpStdioClient (against a real spawned fake MCP server)', () => {
  let client: McpStdioClient | undefined

  afterEach(() => {
    client?.close()
    client = undefined
  })

  it('completes the initialize handshake and lists tools', async () => {
    client = await spawnMcpServer({ command: process.execPath, args: [fixture] })
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['echo', 'boom'])
  })

  it('calls a tool and gets its text content back', async () => {
    client = await spawnMcpServer({ command: process.execPath, args: [fixture] })
    const result = await client.callTool('echo', { text: 'hello mcp' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'hello mcp' }] })
  })

  it('surfaces an unknown tool as a JSON-RPC error', async () => {
    client = await spawnMcpServer({ command: process.execPath, args: [fixture] })
    await expect(client.callTool('nope', {})).rejects.toThrow(/unknown tool/)
  })

  it('adapts an MCP tool into a working ToolDefinition', async () => {
    client = await spawnMcpServer({ command: process.execPath, args: [fixture] })
    const [echoDescriptor] = await client.listTools()
    const tool = mcpToolDefinition(client, echoDescriptor)

    expect(tool.name).toBe('echo')
    expect(tool.permissionLevel).toBe('safe')
    const result = await tool.execute(
      { text: 'via ToolDefinition' },
      { taskId: 't1', signal: new AbortController().signal },
    )
    expect(result).toEqual({ ok: true, content: 'via ToolDefinition' })
  })

  it('maps an MCP isError result into a failed ToolResult', async () => {
    client = await spawnMcpServer({ command: process.execPath, args: [fixture] })
    const tools = await client.listTools()
    const boomDescriptor = tools.find((t) => t.name === 'boom')!
    const tool = mcpToolDefinition(client, boomDescriptor)
    const result = await tool.execute({}, { taskId: 't1', signal: new AbortController().signal })
    expect(result).toEqual({ ok: false, content: '', error: 'something went wrong' })
  })
})
