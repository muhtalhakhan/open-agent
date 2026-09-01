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
