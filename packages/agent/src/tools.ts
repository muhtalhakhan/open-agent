import type { PermissionLevel, ToolCall, ToolDefinition, ToolExecutionContext, ToolResult } from './types.js'

export type ApprovalHandler = (call: ToolCall, tool: ToolDefinition) => boolean | Promise<boolean>

/**
 * The scoped tool registry and guarded execution pipeline. Every tool
 * declares a permission level; anything above "safe" is denied unless an
 * approval handler explicitly allows it. This is the one place a tool call
 * turns into a side effect, so it is also where audit logging hooks in.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly enabledDangerous = new Set<string>()
  private approvalHandler: ApprovalHandler = () => false
  readonly auditLog: Array<{
    call: ToolCall
    permissionLevel: PermissionLevel
    approved: boolean
    result: ToolResult
  }> = []

  register(tool: ToolDefinition): () => void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`)
    }
    this.tools.set(tool.name, tool)
    return () => this.tools.delete(tool.name)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  /** Allow a specific tool's "dangerous" level to even be offered/approved. */
  enableDangerous(name: string): void {
    this.enabledDangerous.add(name)
  }

  onApproval(handler: ApprovalHandler): void {
    this.approvalHandler = handler
  }

  private async decide(call: ToolCall, tool: ToolDefinition): Promise<boolean> {
    if (tool.permissionLevel === 'safe') return true
    if (tool.permissionLevel === 'dangerous' && !this.enabledDangerous.has(tool.name)) return false
    return this.approvalHandler(call, tool)
  }

  /** Run one tool call through the pre-execute policy gate, execution, and audit log. */
  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name)
    if (!tool) {
      const result: ToolResult = { ok: false, content: '', error: `unknown tool "${call.name}"` }
      return result
    }

    const approved = await this.decide(call, tool)
    if (!approved) {
      const result: ToolResult = {
        ok: false,
        content: '',
        error: `tool "${call.name}" requires approval and was not approved`,
      }
      this.auditLog.push({ call, permissionLevel: tool.permissionLevel, approved: false, result })
      return result
    }

    let result: ToolResult
    try {
      result = await tool.execute(call.args, context)
    } catch (err) {
      result = { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
    }
    this.auditLog.push({ call, permissionLevel: tool.permissionLevel, approved: true, result })
    return result
  }
}
