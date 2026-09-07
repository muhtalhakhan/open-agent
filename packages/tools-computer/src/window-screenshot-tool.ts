import type { ToolDefinition } from '@open-agent/agent'
import type { WindowOperator } from './types.js'

export function windowScreenshotTool(operator: WindowOperator): ToolDefinition<{ windowId: string }> {
  return {
    name: 'window_screenshot',
    description: 'Capture a screenshot of a specific OS window by its window ID (use window_list to discover IDs).',
    schema: {
      type: 'object',
      properties: {
        windowId: { type: 'string', description: 'Window identifier from window_list.' },
      },
      required: ['windowId'],
    },
    permissionLevel: 'safe',
    async execute(args) {
      try {
        const { base64, scaleFactor } = await operator.screenshot(args.windowId)
        return {
          ok: true,
          content: `[window screenshot captured: ${base64.length} base64 chars, scaleFactor=${scaleFactor}]`,
        }
      } catch (err) {
        return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
