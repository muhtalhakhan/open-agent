import type { ToolDefinition } from '@open-agent/agent'
import type { ScreenshotOperator } from './types.js'

/**
 * Standalone screenshot-capture tool — usable on its own (e.g. so the model
 * can look before deciding whether to delegate to the full computer-use
 * agent loop), independent of `computerUseTaskTool`.
 */
export function computerScreenshotTool(operator: ScreenshotOperator): ToolDefinition<Record<string, never>> {
  return {
    name: 'computer_screenshot',
    description: 'Capture a screenshot of the current screen.',
    schema: { type: 'object', properties: {} },
    permissionLevel: 'safe',
    async execute() {
      try {
        const { base64, scaleFactor } = await operator.screenshot()
        return { ok: true, content: `[screenshot captured: ${base64.length} base64 chars, scaleFactor=${scaleFactor}]` }
      } catch (err) {
        return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
