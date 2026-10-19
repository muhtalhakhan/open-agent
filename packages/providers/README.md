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

## `GeminiProvider`

Dedicated adapter for Google's Gemini GenerateContent API. Maps system instructions to `systemInstruction`, tools to `functionDeclarations`, and resolves tool call IDs to names for function responses.

```ts
import { GeminiProvider } from '@open-agent/providers'

const llm = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: 'gemini-2.0-flash',
})
```

All providers accept an optional `baseURL` override and `fetchFn` for testing.

## `AnthropicProvider`

Dedicated adapter for Anthropic's Messages API. Maps system instructions to the root `system` field, tools to `tools[].input_schema`, and handles the alternating `user`/`assistant` role requirement with tool results coalesced into single user messages.

```ts
import { AnthropicProvider } from '@open-agent/providers'

const llm = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-3-5-sonnet-20241022',
})
```

## Token usage

Every adapter returns the provider's own token count with each response, as `LlmResponse.usage` (`inputTokens`, `outputTokens`, and `cachedInputTokens` where the provider breaks it out), for streamed and plain responses alike. The agent loop logs it with the reply, which is what `--history`, the REPL and the web UI total per task. It is left out, not zeroed, when a provider does not report it.

Each API counts differently, and each adapter normalises to "everything the model read" for input:

- **OpenAI-compatible:** `usage.prompt_tokens` / `completion_tokens`, with `prompt_tokens_details.cached_tokens` as the cached part. A stream only reports usage when asked, so streamed requests send `stream_options: { include_usage: true }`. A server that rejects that field (400/422 naming it) is retried once without it and not asked again by that adapter instance.
- **Anthropic:** `input_tokens` covers only uncached input, so cache writes and reads are added to it, and reads are reported as cached. When streaming, input arrives with `message_start` and the final output count with `message_delta`.
- **Gemini:** `usageMetadata.promptTokenCount`, with `thoughtsTokenCount` added to output since thinking is billed as output. When streaming, every chunk repeats the running totals, so the last one is used.

## Credential resolution

`resolveCredential` reads an API key from `<NAME>` or, failing that, from a
file named by `<NAME>_FILE` — the shape Docker secrets, Kubernetes secret
volumes and systemd's `LoadCredential=` deliver credentials in, none of which
put the value in the process environment where every child process can read it.

```ts
import { apiKeyVarsFor, resolveCredential } from '@open-agent/providers'

// Tries OPENROUTER_API_KEY, OPENROUTER_API_KEY_FILE, then the same pair for
// OPENAI_API_KEY, because the base URL points at OpenRouter.
const key = resolveCredential(apiKeyVarsFor(baseURL), { env: process.env })
if (!key.ok) throw new Error(key.error) // names the variable, never the value
```

An empty or whitespace-only variable counts as unset, a trailing newline is
trimmed, and a value with interior whitespace or control characters is rejected
rather than smuggled into a request header. Failures carry a `reason` —
`missing` is an unconfigured optional credential, while `unreadable` and
`malformed` are operator mistakes worth failing on.

## Keeping keys out of logs

`redactUrl` catches credentials that travel as query parameters and is applied
to every `ProviderHttpError` automatically. For keys sent as headers, wrap the
logger with the values you resolved:

```ts
import { createRedactingLogger } from '@open-agent/providers'

const logger = createRedactingLogger(consoleLogger, [key.value])
```

Every string it logs — event name, nested data, arrays — has those values
replaced with `[REDACTED]`, so a provider echoing the request back in an error
body cannot reintroduce the key.
