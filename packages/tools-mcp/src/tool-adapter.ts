import type { PermissionLevel, ToolDefinition, ToolResult } from '@open-agent/agent'
import type { McpStdioClient } from './client.js'
import type { McpCallToolResult, McpToolDescriptor } from './types.js'

function renderContent(result: McpCallToolResult): string {
  const parts: string[] = []
  for (const block of result.content) {
    if (block.type === 'text' && block.text) parts.push(block.text)
    else if (block.type === 'image') parts.push(`[image content omitted: ${block.mimeType ?? 'unknown mime type'}]`)
    else if (block.type === 'resource') parts.push('[resource content omitted]')
  }
  return parts.join('\n')
}

export interface McpToolOptions {
  /**
   * Whether the tool's output is fenced as untrusted (default true). An MCP
   * server relays whatever its backend returns — a page, an inbox, a ticket
   * someone else wrote — so its output is untrusted unless the caller knows
   * better, for instance a local server that only reports on its own state.
   */
  untrustedOutput?: boolean
}

/**
 * Wraps one MCP tool as a `ToolDefinition` so it can be registered on our
 * ToolRegistry like any native tool. The permission level is a policy
 * decision the caller makes per tool (an MCP server has no concept of our
 * safe/ask/dangerous levels) — `readOnlyHint` is a hint, not a guarantee.
 */
export function mcpToolDefinition(
  client: McpStdioClient,
  descriptor: McpToolDescriptor,
  permissionLevel: PermissionLevel = 'safe',
  options: McpToolOptions = {},
): ToolDefinition {
  return {
    name: descriptor.name,
    description: descriptor.description ?? '',
    schema: descriptor.inputSchema,
    permissionLevel,
    untrustedOutput: options.untrustedOutput ?? true,
    async execute(args): Promise<ToolResult> {
      try {
        const result = await client.callTool(descriptor.name, args)
        const content = renderContent(result)
        return result.isError ? { ok: false, content: '', error: content } : { ok: true, content }
      } catch (err) {
        return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
