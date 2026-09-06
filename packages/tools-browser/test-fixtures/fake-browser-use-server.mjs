// Mimics browser-use's real MCP server (see browser_use/mcp/server.py's
// handle_list_tools) so BrowserUseTools' policy mapping and tool wiring can be
// tested end-to-end without needing Python or the real browser-use installed.
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the browser',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'browser_click',
    description: 'Click on an element on the page',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number' }, xpath: { type: 'string' } },
      required: ['index'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input field',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number' }, text: { type: 'string' } },
      required: ['index', 'text'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page up or down',
    inputSchema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' } },
      required: ['direction'],
    },
  },
  {
    name: '__env',
    description: 'test-only: reports the environment this server was started with',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_get_state',
    description: 'Get the current page state including URL and title',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_extract_content',
    description: 'Extract the text content of the current page',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
    },
  },
  {
    name: 'browser_get_html',
    description: 'Get the HTML of the current page or a specific element',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
    },
  },
  {
    name: 'browser_list_tabs',
    description: 'List all open browser tabs',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_switch_tab',
    description: 'Switch to a specific browser tab',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_close_tab',
    description: 'Close the current or a specific browser tab',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
    },
  },
  {
    name: 'retry_with_browser_use_agent',
    description: 'Delegate a task to the autonomous browser-use agent',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
  },
  {
    name: 'browser_close_session',
    description: 'Close the current browser session',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_close_all',
    description: 'Close all browser sessions',
    inputSchema: { type: 'object', properties: {} },
  },
]

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  const message = JSON.parse(trimmed)

  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'fake-browser-use', version: '0.0.0' },
    })
  } else if (message.method === 'notifications/initialized') {
    // notification, no reply
  } else if (message.method === 'tools/list') {
    reply(message.id, { tools: TOOLS })
  } else if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params
    const handlers = {
      browser_navigate: () => `navigated to ${args.url}`,
      browser_click: () => `clicked element at index ${args.index}`,
      browser_type: () => `typed "${args.text}" into element at index ${args.index}`,
      browser_scroll: () => `scrolled ${args.direction}${args.amount ? ` by ${args.amount}` : ''}`,
      browser_screenshot: () => `[screenshot captured]`,
      browser_get_state: () => `{"url":"https://example.com","title":"Example"}`,
      browser_extract_content: () => `extracted content${args.selector ? ` from ${args.selector}` : ''}`,
      browser_get_html: () => `<html>${args.selector ? `<div>${args.selector}</div>` : '<body></body>'}</html>`,
      browser_list_tabs: () => `[{"tabId":0,"url":"https://example.com","title":"Example"}]`,
      browser_switch_tab: () => `switched to tab ${args.tabId}`,
      browser_close_tab: () => `closed tab${args.tabId !== undefined ? ` ${args.tabId}` : ''}`,
      retry_with_browser_use_agent: () => `agent completed task: ${args.task}`,
      browser_close_session: () => `session closed`,
      browser_close_all: () => `all sessions closed`,
      // Not a browser-use tool. It reports the environment this subprocess was
      // actually started with, so a test can assert what the parent passed
      // through rather than trusting that it did.
      __env: () => JSON.stringify(process.env),
    }
    const handler = handlers[name]
    const text = handler ? handler() : `called ${name}`
    reply(message.id, { content: [{ type: 'text', text }] })
  }
})
