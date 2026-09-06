import { spawn } from 'node:child_process'
import { filterEnv } from '@open-agent/agent'
import { McpStdioClient } from './client.js'

export interface SpawnMcpServerOptions {
  command: string
  args?: string[]
  /** Variables to add for this server. Not subject to credential filtering — you set them on purpose. */
  env?: Record<string, string>
  clientName?: string
  /**
   * Credential-looking variables from the agent's own environment to let
   * through, e.g. `["GITHUB_TOKEN"]` for a server that needs one.
   */
  allowEnv?: readonly string[]
  /**
   * Hand the server the agent's environment untouched. Off by default, and
   * worth leaving off: an MCP server is a third-party program, and the
   * default inheritance would give it every API key the agent holds.
   */
  inheritAllEnv?: boolean
}

/**
 * Spawns a subprocess speaking the MCP stdio protocol and connects a client to it.
 *
 * The inherited environment is credential-filtered first. An MCP server is
 * someone else's program running on the user's machine with the agent's
 * environment, which is where every API key the agent was configured with
 * lives — the server does not need them, and anything it prints comes back as
 * tool output. `env` entries are applied after the filter, so a server that
 * needs a key can still be given exactly the one it needs.
 */
export async function spawnMcpServer(options: SpawnMcpServerOptions): Promise<McpStdioClient> {
  const inherited = options.inheritAllEnv === true ? process.env : filterEnv(process.env, options.allowEnv).env
  const proc = spawn(options.command, options.args ?? [], {
    env: { ...inherited, ...options.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const client = new McpStdioClient(proc, options.clientName)
  await client.connect()
  return client
}
