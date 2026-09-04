export { ProviderHttpError, redactUrl } from './errors.js'
export { OpenAiCompatibleProvider } from './openai-compatible.js'
export type { OpenAiCompatibleOptions } from './openai-compatible.js'
export { GeminiProvider } from './gemini.js'
export type { GeminiOptions } from './gemini.js'
export { AnthropicProvider } from './anthropic.js'
export type { AnthropicOptions } from './anthropic.js'
// Multi-provider fallback adapter — falls through to the next adapter on
// 401/403/429 (account problems) and 408/502/503/504/529 (provider down or
// overloaded), re-throwing 400 and 500 immediately, and respects AbortSignal. Adapter order is
// re-derived per call rather than held in a shared mutable cursor, so
// concurrent calls cannot race.
export { ProviderFallbackAdapter } from './fallback-provider.js'
export type { FallbackAdapterOptions } from './fallback-provider.js'
