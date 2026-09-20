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
  /**
   * Set when the tool's output carries content from outside the user's
   * control — a fetched page, an API response, search results.
   * `ToolRegistry` fences that output as data before the model sees it, and a
   * task that has read any stops being covered by remembered approvals, since
   * the next call might be the content's idea rather than the user's.
   */
  untrustedOutput?: boolean
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
  | {
      type: 'lease/requested'
      taskId: string
      at: number
      kind: TakeoverKind
      reason: string
      /** The site or machine a person is being asked to deal with. */
      target?: string
    }
  | { type: 'lease/returned'; taskId: string; at: number; outcome: TakeoverOutcome }

/**
 * Why control is being handed to a person: they asked for the wheel, or the
 * agent reached something only a person can do, such as a login wall.
 */
export type TakeoverKind = 'takeover' | 'login'

export interface TakeoverRequest {
  taskId: string
  kind: TakeoverKind
  /** Why, in the agent's own words, shown to the person being asked. */
  reason: string
  /** The site or machine in question, for a login. */
  target?: string
}

/**
 * How a handoff ended. Deliberately a closed set and not free text: anything
 * a person types while driving — a password above all — must have no way back
 * into the transcript. See `lease.ts`.
 */
export type TakeoverOutcome = 'completed' | 'declined' | 'cancelled' | 'unavailable' | 'busy' | 'failed'

/** Who is driving a task right now. */
export type LeaseState = { holder: 'agent' } | { holder: 'pending' | 'human'; since: number; reason: string }

export type TaskStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'error'

export interface TaskState {
  id: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  error?: string
}
