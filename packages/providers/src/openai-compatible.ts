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

export interface OpenAiCompatibleOptions {
  /** e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1, http://localhost:11434/v1 (Ollama), http://localhost:1234/v1 (LM Studio). */
  baseURL: string
  apiKey: string
  model: string
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function toOpenAiMessage(message: Message): OpenAiMessage {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.toolCallId }
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

function toOpenAiTool(tool: Pick<ToolDefinition, 'name' | 'description' | 'schema'>) {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.schema } }
}

function fromOpenAiMessage(choiceMessage: {
  content?: string | null
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
}): Message {
  const toolCalls: ToolCall[] | undefined = choiceMessage.tool_calls?.map((call) => ({
    id: call.id,
    name: call.function.name,
    args: JSON.parse(call.function.arguments || '{}'),
  }))
  return { role: 'assistant', content: choiceMessage.content ?? '', toolCalls }
}

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
  }>
  /** Some servers (OpenRouter, Ollama) report a failure mid-stream as a chunk rather than a status. */
  error?: { message?: string }
}

/**
 * Folds `chat.completion.chunk`s back into the message the non-streaming API
 * would have returned. A tool call's arguments arrive as fragments of one
 * JSON string, keyed by `index`, and are only parsed once the stream ends.
 */
async function readChunks(
  body: ReadableStream<Uint8Array>,
  provider: string,
  onText: (event: TextStreamEvent) => void,
): Promise<Message> {
  let content = ''
  const calls: Array<{ id: string; function: { name: string; arguments: string } }> = []
  for await (const { data } of readSse(body)) {
    if (data === '[DONE]') break
    const chunk = JSON.parse(data) as OpenAiChunk
    if (chunk.error)
      throw new Error(`${provider}: stream failed: ${chunk.error.message ?? JSON.stringify(chunk.error)}`)
    const delta = chunk.choices?.[0]?.delta
    if (!delta) continue
    if (delta.content) {
      content += delta.content
      onText({ type: 'delta', text: delta.content })
    }
    for (const part of delta.tool_calls ?? []) {
      const call = (calls[part.index ?? 0] ??= { id: '', function: { name: '', arguments: '' } })
      if (part.id) call.id = part.id
      if (part.function?.name) call.function.name += part.function.name
      if (part.function?.arguments) call.function.arguments += part.function.arguments
    }
  }
  const toolCalls = calls.filter(Boolean)
  return fromOpenAiMessage({ content, tool_calls: toolCalls.length ? toolCalls : undefined })
}

/**
 * Works against any provider that speaks the OpenAI chat-completions API
 * shape (OpenAI itself, OpenRouter, Ollama, LM Studio, self-hosted vLLM,
 * ...) — see the "Provider interface" section of docs/agent-design.md.
 * Anthropic and Gemini need dedicated adapters since their request/response
 * shapes diverge from this one.
 */
export class OpenAiCompatibleProvider implements LlmAdapter {
  readonly name = 'openai-compatible'

  constructor(private readonly options: OpenAiCompatibleOptions) {}

  async generate(request: LlmRequest, signal: AbortSignal, options: GenerateOptions = {}): Promise<LlmResponse> {
    const fetchFn = this.options.fetchFn ?? fetch
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: request.messages.map(toOpenAiMessage),
    }
    if (request.tools.length) body.tools = request.tools.map(toOpenAiTool)
    if (options.onText) body.stream = true

    const response = await fetchFn(`${this.options.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      throw new ProviderHttpError(response.status, this.name, this.options.baseURL, await response.text())
    }

    const events = options.onText ? sseBody(response) : null
    if (events && options.onText) return { message: await readChunks(events, this.name, options.onText) }

    const data = (await response.json()) as { choices: Array<{ message: Parameters<typeof fromOpenAiMessage>[0] }> }
    return { message: fromOpenAiMessage(data.choices[0].message) }
  }
}
