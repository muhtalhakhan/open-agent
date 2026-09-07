import type { ToolDefinition } from '@open-agent/agent'
import type { WindowOperator, WindowInfo } from './types.js'

export function windowListTool(operator: WindowOperator): ToolDefinition<Record<string, never>> {
  return {
    name: 'window_list',
    description: 'List all open OS windows with their title, app, bounds, and focus state.',
    schema: { type: 'object', properties: {} },
    permissionLevel: 'safe',
    async execute() {
      try {
        const windows = await operator.list()
        const lines = windows.map((w: WindowInfo) => {
          const b = w.bounds
          return `[${w.id}] "${w.title}" | ${w.appName} | x=${b.x} y=${b.y} w=${b.width} h=${b.height} | focused=${w.isFocused} | minimized=${w.isMinimized}`
        })
        return { ok: true, content: `Found ${windows.length} window(s):\n${lines.join('\n') || '(none)'}` }
      } catch (err) {
        return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
