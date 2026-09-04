import { randomUUID } from 'node:crypto'
import { ProviderHttpError } from './errors.js'
import type { LlmAdapter, LlmRequest, LlmResponse, Message, ToolCall, ToolDefinition } from '@open-agent/agent'

export interface GeminiOptions {
  /** defaults to https://generativelanguage.googleapis.com/v1beta */
  baseURL?: string
  apiKey: string
  model: string
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch
}

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: { result: string } }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

function toGeminiTool(tool: Pick<ToolDefinition, 'name' | 'description' | 'schema'>) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
  }
}

export class GeminiProvider implements LlmAdapter {
  readonly name = 'gemini'

  constructor(private readonly options: GeminiOptions) {}

  async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    const fetchFn = this.options.fetchFn ?? fetch
    const baseURL = this.options.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta'
    const model = this.options.model

    // Extract system instruction
    const systemMessages = request.messages.filter((m) => m.role === 'system')
    const systemInstruction = systemMessages.map((m) => m.content).join('\n\n')

    // Build a map from tool call ID to tool name, for resolving tool results
    const toolCallIdToName = new Map<string, string>()
    for (const msg of request.messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const call of msg.toolCalls) {
          toolCallIdToName.set(call.id, call.name)
        }
      }
    }

    const contents: GeminiContent[] = []

    // Group consecutive same-role messages
    let currentRole: 'user' | 'model' | null = null
    let currentParts: GeminiPart[] = []

    const flush = () => {
      if (currentRole && currentParts.length > 0) {
        contents.push({ role: currentRole, parts: currentParts })
      }
      currentParts = []
    }

    for (const msg of request.messages) {
      if (msg.role === 'system') continue

      const targetRole = msg.role === 'assistant' ? 'model' : 'user'

      if (currentRole !== targetRole) {
        flush()
        currentRole = targetRole
      }

      if (msg.role === 'user') {
        if (msg.content) {
          currentParts.push({ text: msg.content })
        }
      } else if (msg.role === 'tool') {
        // Resolve tool call ID to name
        const toolName = msg.toolCallId ? toolCallIdToName.get(msg.toolCallId) : undefined
        if (toolName) {
          currentParts.push({
            functionResponse: { name: toolName, response: { result: msg.content } },
          })
        } else {
          console.warn(
            `[GeminiProvider] tool result for unknown toolCallId "${msg.toolCallId}" — result will not be sent to the model`,
          )
        }
      } else if (msg.role === 'assistant') {
        if (msg.content) {
          currentParts.push({ text: msg.content })
        }
        if (msg.toolCalls) {
          for (const call of msg.toolCalls) {
            currentParts.push({
              functionCall: { name: call.name, args: call.args },
            })
          }
        }
      }
    }
    flush()

    const body: Record<string, unknown> = {
      contents,
    }

    if (systemInstruction) {
      body.systemInstruction = {
        role: 'user',
        parts: [{ text: systemInstruction }],
      }
    }

    if (request.tools.length) {
      body.tools = [{ functionDeclarations: request.tools.map(toGeminiTool) }]
    }

    const url = `${baseURL}/models/${model}:generateContent?key=${this.options.apiKey}`

    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      throw new ProviderHttpError(response.status, this.name, url, await response.text())
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] } }>
    }

    const message: Message = { role: 'assistant', content: '' }
    const toolCalls: ToolCall[] = []

    const firstCandidate = data.candidates?.[0]
    const parts = firstCandidate?.content?.parts ?? []

    for (const part of parts) {
      if (part.text !== undefined) {
        message.content += part.text
      }
      if (part.functionCall) {
        toolCalls.push({
          id: randomUUID(),
          name: part.functionCall.name,
          args: part.functionCall.args,
        })
      }
    }

    if (toolCalls.length > 0) {
      message.toolCalls = toolCalls
    }

    return { message }
  }
}
