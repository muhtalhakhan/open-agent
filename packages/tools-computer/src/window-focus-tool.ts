import type { ToolDefinition } from '@open-agent/agent'
import type { WindowOperator } from './types.js'

export function windowFocusTool(operator: WindowOperator): ToolDefinition<{ windowId: string }> {
  return {
    name: 'window_focus',
    description: 'Bring a specific OS window to the foreground (focus it). Use window_list to discover IDs.',
    schema: {
      type: 'object',
      properties: {
        windowId: { type: 'string', description: 'Window identifier from window_list.' },
      },
      required: ['windowId'],
    },
    permissionLevel: 'ask',
    async execute(args) {
      try {
        await operator.focus(args.windowId)
        return { ok: true, content: `Window ${args.windowId} focused.` }
      } catch (err) {
        return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
