import { createInterface } from 'node:readline'
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, McpCallToolResult, McpProcessLike, McpToolDescriptor } from './types.js'

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

/**
 * A minimal MCP client over the stdio transport: newline-delimited JSON-RPC 2.0
 * messages, one per line, in both directions. Just enough of the protocol to
 * discover and call tools on a spawned MCP server — not resources, prompts,
 * or sampling.
 */
export class McpStdioClient {
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private connected = false

  constructor(private readonly proc: McpProcessLike, private readonly clientName = 'open-agent') {
    createInterface({ input: this.proc.stdout }).on('line', (line) => this.handleLine(line))
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let message: JsonRpcResponse
    try {
      message = JSON.parse(trimmed)
    } catch {
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`))
    else pending.resolve(message.result)
  }

  private send(message: JsonRpcRequest | JsonRpcNotification): void {
    this.proc.stdin.write(JSON.stringify(message) + '\n')
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Perform the MCP initialize handshake. Must be called before any other request. */
  async connect(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: this.clientName, version: '0.1.0' },
    })
    this.notify('notifications/initialized')
    this.connected = true
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    if (!this.connected) throw new Error('call connect() before listTools()')
    const result = await this.request<{ tools: McpToolDescriptor[] }>('tools/list')
    return result.tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    if (!this.connected) throw new Error('call connect() before callTool()')
    return this.request<McpCallToolResult>('tools/call', { name, arguments: args })
  }

  close(): void {
    for (const { reject } of this.pending.values()) reject(new Error('MCP client closed'))
    this.pending.clear()
    this.proc.kill()
  }
}
