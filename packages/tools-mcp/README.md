# @open-agent/tools-mcp

A minimal MCP client for the stdio transport: spawn a server, do the `initialize` handshake, list its tools, call them, and adapt each one into an `@open-agent/agent` `ToolDefinition` so it can be registered on a `ToolRegistry` like any native tool.

## Pieces

- **`McpStdioClient`** (`src/client.ts`) — newline-delimited JSON-RPC 2.0 over a process's stdin/stdout. `connect()`, `listTools()`, `callTool()`, `close()`.
- **`spawnMcpServer()`** (`src/spawn.ts`) — spawns a subprocess and connects a client to it in one call.
- **`mcpToolDefinition()`** (`src/tool-adapter.ts`) — wraps one MCP tool descriptor as a `ToolDefinition`. The caller picks the `permissionLevel` — MCP has no concept of our `safe`/`ask`/`dangerous` levels.

## Example

```ts
import { spawnMcpServer, mcpToolDefinition } from '@open-agent/tools-mcp'

const client = await spawnMcpServer({ command: 'node', args: ['./my-mcp-server.js'] })
const descriptors = await client.listTools()
const tools = descriptors.map((d) => mcpToolDefinition(client, d))
```

`src/client.test.ts` spawns a real (fake, for testing) MCP server from `test-fixtures/` and drives the client against it end to end — no mocked streams.

See `@open-agent/tools-browser` for a concrete consumer (browser-use's MCP server).

## Environment

`spawnMcpServer` credential-filters the environment it passes on: an MCP server is a third-party program started with the agent's environment, which is where every API key the agent was configured with lives, and anything the server prints comes back as tool output. Variables whose names look like credentials (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, …) are removed.

`allowEnv` names exceptions for a server that genuinely needs one; `env` adds variables you set on purpose and is not filtered; `inheritAllEnv: true` turns the filtering off entirely, which is worth a moment's thought before you write it.
