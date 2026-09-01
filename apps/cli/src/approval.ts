import type { ApprovalHandler, ToolCall, ToolDefinition } from '@open-agent/agent'

/**
 * Prompts the user in the terminal before an `ask`/`dangerous` tool runs.
 * `ask` is a function so tests can inject a fake prompt instead of real stdin.
 */
export function createTerminalApprovalHandler(ask: (question: string) => Promise<string>): ApprovalHandler {
  return async (call: ToolCall, tool: ToolDefinition) => {
    const args = JSON.stringify(call.args)
    const answer = await ask(`\n⚠ Approve "${tool.name}" (${tool.permissionLevel}) with args ${args}? [y/N] `)
    return answer.trim().toLowerCase().startsWith('y')
  }
}
