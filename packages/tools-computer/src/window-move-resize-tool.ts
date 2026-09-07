import type { ToolDefinition } from '@open-agent/agent'
import type { WindowOperator } from './types.js'

export function windowMoveResizeTool(operator: WindowOperator): ToolDefinition<{
  windowId: string
  x?: number
  y?: number
  width?: number
  height?: number
}> {
  return {
    name: 'window_move_resize',
    description: 'Move and/or resize a specific OS window by its window ID. Pass only the fields you want to change.',
    schema: {
      type: 'object',
      properties: {
        windowId: { type: 'string', description: 'Window identifier from window_list.' },
        x: { type: 'number', description: 'New left position in pixels.' },
        y: { type: 'number', description: 'New top position in pixels.' },
        width: { type: 'number', description: 'New width in pixels.' },
        height: { type: 'number', description: 'New height in pixels.' },
      },
      required: ['windowId'],
    },
    permissionLevel: 'ask',
    async execute(args) {
      try {
        if (args.x === undefined && args.y === undefined && args.width === undefined && args.height === undefined) {
          return { ok: false, content: '', error: 'At least one of x, y, width, or height must be provided.' }
        }
        await operator.setBounds(args.windowId, {
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
        })
        const parts: string[] = []
        if (args.x !== undefined) parts.push(`x=${args.x}`)
        if (args.y !== undefined) parts.push(`y=${args.y}`)
        if (args.width !== undefined) parts.push(`w=${args.width}`)
        if (args.height !== undefined) parts.push(`h=${args.height}`)
        return { ok: true, content: `Window ${args.windowId} updated (${parts.join(', ') || 'no bounds changed'}).` }
      } catch (err) {
        return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
