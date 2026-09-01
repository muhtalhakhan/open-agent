export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  /** MCP tool annotations, e.g. `{ readOnlyHint: true }`. */
  annotations?: Record<string, unknown>
}

export interface McpContentBlock {
  type: 'text' | 'image' | 'resource'
  text?: string
  data?: string
  mimeType?: string
}

export interface McpCallToolResult {
  content: McpContentBlock[]
  isError?: boolean
}

/** The subset of a spawned process this client actually needs — narrow so tests can fake it. */
export interface McpProcessLike {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  kill(): void
}
