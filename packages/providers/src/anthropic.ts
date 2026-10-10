import { randomUUID } from 'node:crypto'
import { ProviderHttpError } from './errors.js'
import { readSse, sseBody } from './sse.js'
import type {
  GenerateOptions,
  LlmAdapter,
  LlmRequest,
  LlmResponse,
  Message,
  TextStreamEvent,
  ToolCall,
  ToolDefinition,
} from '@open-agent/agent'

export interface AnthropicOptions {
  /** Defaults to https://api.anthropic.com/v1 */
  baseURL?: string
  apiKey: string
  model: string
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch
}

interface AnthropicBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  is_error?: boolean
}

function toAnthropicBlock(message: Message): { role: 'user' | 'assistant'; content: AnthropicBlock[] } {
  const content: AnthropicBlock[] = []

  if (message.role === 'user') {
    if (message.content) {
      content.push({ type: 'text', text: message.content })
    }
  } else if (message.role === 'assistant') {
    if (message.content) {
      content.push({ type: 'text', text: message.content })
    }
    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
      }
    }
  }

  return { role: message.role as 'user' | 'assistant', content }
}

function toAnthropicTool(tool: Pick<ToolDefinition, 'name' | 'description' | 'schema'>) {
  return { name: tool.name, description: tool.description, input_schema: tool.schema }
}

export class AnthropicProvider implements LlmAdapter {
  readonly name = 'anthropic'

  constructor(private readonly options: AnthropicOptions) {}

  async generate(request: LlmRequest, signal: AbortSignal, options: GenerateOptions = {}): Promise<LlmResponse> {
    const fetchFn = this.options.fetchFn ?? fetch
    const baseURL = this.options.baseURL ?? 'https://api.anthropic.com/v1'
    const model = this.options.model

    // Extract system instruction
    const systemMessages = request.messages.filter((m) => m.role === 'system')
    const systemInstruction = systemMessages.map((m) => m.content).join('\n\n')

    // Convert non-system messages, grouping consecutive tool results under a single user role
    const convertedMessages: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []

    let currentRole: 'user' | 'assistant' | null = null
    let currentParts: AnthropicBlock[] = []

    const flush = () => {
      if (currentRole && currentParts.length > 0) {
        convertedMessages.push({ role: currentRole, content: currentParts })
      }
      currentParts = []
    }

    for (const msg of request.messages) {
      if (msg.role === 'system') continue

      if (msg.role === 'tool') {
        // Tool results go under role: 'user', coalesced into a single message
        if (currentRole !== 'user') {
          flush()
          currentRole = 'user'
        }
        currentParts.push({
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content,
          is_error: false,
        })
      } else {
        if (currentRole !== msg.role) {
          flush()
          currentRole = msg.role as 'user' | 'assistant'
        }
        const { content } = toAnthropicBlock(msg)
        currentParts.push(...content)
      }
    }
    flush()

    const body: Record<string, unknown> = {
      model,
      messages: convertedMessages,
      max_tokens: 4096,
    }

    if (systemInstruction) {
      body.system = systemInstruction
    }

    if (request.tools.length) {
      body.tools = request.tools.map(toAnthropicTool)
    }

    if (options.onText) {
      body.stream = true
    }

    const url = `${baseURL}/messages`

    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.options.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      throw new ProviderHttpError(response.status, this.name, url, await response.text())
    }

    const events = options.onText ? sseBody(response) : null
    if (events && options.onText) {
      return { message: fromAnthropicContent(await readStream(events, url, options.onText)) }
    }

    const data = (await response.json()) as {
      content: AnthropicBlock[]
    }
    return { message: fromAnthropicContent(data.content) }
  }
}

function fromAnthropicContent(blocks: AnthropicBlock[]): Message {
  const message: Message = { role: 'assistant', content: '' }
  const toolCalls: ToolCall[] = []

  for (const block of blocks) {
    if (block.type === 'text' && block.text !== undefined) {
      message.content += block.text
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? randomUUID(),
        name: block.name ?? '',
        args: block.input ?? {},
      })
    }
  }

  if (toolCalls.length > 0) {
    message.toolCalls = toolCalls
  }

  return message
}

type AnthropicStreamEvent =
  | { type: 'content_block_start'; index: number; content_block: AnthropicBlock }
  | {
      type: 'content_block_delta'
      index: number
      delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string }
    }
  | { type: 'error'; error: { type: string; message: string } }
  | { type: 'message_start' | 'message_delta' | 'message_stop' | 'content_block_stop' | 'ping' }

/**
 * Rebuilds the `content` array the non-streaming API returns from the
 * `content_block_*` events, so both paths end in `fromAnthropicContent`. A
 * tool call's input arrives as fragments of one JSON string and is parsed
 * once the stream ends.
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  url: string,
  onText: (event: TextStreamEvent) => void,
): Promise<AnthropicBlock[]> {
  const blocks: AnthropicBlock[] = []
  const inputJson: string[] = []
  for await (const { data } of readSse(body)) {
    const event = JSON.parse(data) as AnthropicStreamEvent
    if (event.type === 'content_block_start') {
      blocks[event.index] = { ...event.content_block }
      inputJson[event.index] = ''
    } else if (event.type === 'content_block_delta') {
      const block = blocks[event.index]
      if (!block) continue
      if (event.delta.type === 'text_delta') {
        block.text = (block.text ?? '') + event.delta.text
        onText({ type: 'delta', text: event.delta.text })
      } else if (event.delta.type === 'input_json_delta') {
        inputJson[event.index] += event.delta.partial_json
      }
    } else if (event.type === 'error') {
      // Mid-stream errors come after a 200, so the status that would have
      // said "overloaded" never arrives. It is restored here, so the fallback
      // adapter still routes around the overload instead of failing on it.
      const status = event.error.type === 'overloaded_error' ? 529 : 500
      throw new ProviderHttpError(status, 'anthropic', url, data)
    }
  }
  for (const [index, block] of blocks.entries()) {
    if (block?.type === 'tool_use' && inputJson[index]) block.input = JSON.parse(inputJson[index])
  }
  return blocks.filter(Boolean)
}
