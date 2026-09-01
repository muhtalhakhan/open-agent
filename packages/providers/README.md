# @open-agent/providers

`LlmAdapter` implementations for `@open-agent/agent`. Provider config is `{ baseURL, apiKey, model }` — the agent loop never knows or cares which vendor is behind it.

## `OpenAiCompatibleProvider`

Works against anything that speaks the OpenAI chat-completions API shape: OpenAI itself, OpenRouter, Ollama, LM Studio, self-hosted vLLM, etc. Only `baseURL`/`model` change between them.

```ts
import { OpenAiCompatibleProvider } from '@open-agent/providers'

const llm = new OpenAiCompatibleProvider({
  baseURL: 'https://openrouter.ai/api/v1', // or https://api.openai.com/v1, http://localhost:11434/v1, ...
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
})
```

Anthropic and Gemini need dedicated adapters since their request/response shapes diverge from the OpenAI-compatible one — not yet implemented (Milestone 2).
