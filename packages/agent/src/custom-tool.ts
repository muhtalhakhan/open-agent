import type { ToolDefinition, ToolExecutionContext, ToolResult } from './types.js'

export interface CustomToolSchema {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

export abstract class CustomTool {
  abstract readonly name: string
  abstract readonly description: string

  define(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      schema: this.parameters ?? {},
      permissionLevel: 'safe',
      execute: (args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> => {
        return this.run(args)
      },
    }
  }

  abstract run(args: Record<string, unknown>): Promise<ToolResult>

  protected get parameters(): Record<string, unknown> | undefined {
    return undefined
  }
}
