import { spawn } from 'node:child_process'
import { McpStdioClient } from './client.js'

export interface SpawnMcpServerOptions {
  command: string
  args?: string[]
  env?: Record<string, string>
  clientName?: string
}

/** Spawns a subprocess speaking the MCP stdio protocol and connects a client to it. */
export async function spawnMcpServer(options: SpawnMcpServerOptions): Promise<McpStdioClient> {
  const proc = spawn(options.command, options.args ?? [], {
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const client = new McpStdioClient(proc, options.clientName)
  await client.connect()
  return client
}
