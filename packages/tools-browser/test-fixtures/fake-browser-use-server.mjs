// Mimics a slice of browser-use's real MCP server (see browser_use/mcp/server.py's
// handle_list_tools) so BrowserUseTools' policy mapping and tool wiring can be
// tested end-to-end without needing Python or the real browser-use installed.
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

const TOOLS = [
  { name: 'browser_navigate', description: 'Navigate to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_get_state', description: 'Get page state', inputSchema: { type: 'object', properties: {} } },
  { name: 'retry_with_browser_use_agent', description: 'Delegate to the autonomous agent', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
  { name: 'browser_close_all', description: 'Close all sessions', inputSchema: { type: 'object', properties: {} } },
]

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  const message = JSON.parse(trimmed)

  if (message.method === 'initialize') {
    reply(message.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-browser-use', version: '0.0.0' } })
  } else if (message.method === 'notifications/initialized') {
    // notification, no reply
  } else if (message.method === 'tools/list') {
    reply(message.id, { tools: TOOLS })
  } else if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params
    if (name === 'browser_navigate') {
      reply(message.id, { content: [{ type: 'text', text: `navigated to ${args.url}` }] })
    } else {
      reply(message.id, { content: [{ type: 'text', text: `called ${name}` }] })
    }
  }
})
