export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface Message {
  role: Role
  content: string
  /** Present on an assistant message that is requesting tool calls. */
  toolCalls?: ToolCall[]
  /** Present on a tool-role message: which call this is the result of. */
  toolCallId?: string
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export type PermissionLevel = 'safe' | 'ask' | 'dangerous'

export interface ToolResult {
  ok: boolean
  content: string
  error?: string
}

export interface ToolDefinition<Args extends Record<string, unknown> = Record<string, unknown>> {
  name: string
  description: string
  /** JSON-schema-shaped description of arguments, for prompt assembly. */
  schema: Record<string, unknown>
  permissionLevel: PermissionLevel
  execute(args: Args, context: ToolExecutionContext): Promise<ToolResult>
}

export interface ToolExecutionContext {
  taskId: string
  signal: AbortSignal
}

export interface LlmRequest {
  messages: Message[]
  tools: Pick<ToolDefinition, 'name' | 'description' | 'schema'>[]
}

export interface LlmResponse {
  message: Message
}

export interface LlmAdapter {
  name: string
  generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse>
}

/** A durable, append-only fact about a task. Session state is always a projection of this log. */
export type SessionEvent =
  | { type: 'turn/start'; taskId: string; at: number }
  | { type: 'turn/end'; taskId: string; at: number; reason: 'completed' | 'cancelled' | 'error' }
  | { type: 'step/start'; taskId: string; at: number }
  | { type: 'step/end'; taskId: string; at: number }
  | { type: 'system/message'; taskId: string; at: number; message: Message }
  | { type: 'user/message'; taskId: string; at: number; message: Message }
  | { type: 'assistant/message'; taskId: string; at: number; message: Message }
  | { type: 'tool/call'; taskId: string; at: number; call: ToolCall }
  | { type: 'tool/result'; taskId: string; at: number; callId: string; result: ToolResult }
  | { type: 'retry'; taskId: string; at: number; attempt: number; reason: string }

export type TaskStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'error'

export interface TaskState {
  id: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  error?: string
}
