// A tiny, real MCP stdio server used only in tests: reads newline-delimited
// JSON-RPC requests from stdin, replies on stdout. Exercises McpStdioClient
// against an actual separate process instead of a mocked stream.
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  const message = JSON.parse(trimmed)

  if (message.method === 'initialize') {
    reply(message.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0.0.0' } })
  } else if (message.method === 'notifications/initialized') {
    // notification, no reply
  } else if (message.method === 'tools/list') {
    reply(message.id, {
      tools: [
        {
          name: 'echo',
          description: 'echoes text back',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
        {
          name: 'boom',
          description: 'always fails',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    })
  } else if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params
    if (name === 'echo') {
      reply(message.id, { content: [{ type: 'text', text: args.text }] })
    } else if (name === 'boom') {
      reply(message.id, { content: [{ type: 'text', text: 'something went wrong' }], isError: true })
    } else {
      replyError(message.id, -32602, `unknown tool "${name}"`)
    }
  }
})
