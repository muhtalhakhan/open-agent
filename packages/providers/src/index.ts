export { OpenAiCompatibleProvider } from './openai-compatible.js'
export type { OpenAiCompatibleOptions } from './openai-compatible.js'
export { GeminiProvider } from './gemini.js'
export type { GeminiOptions } from './gemini.js'
export { AnthropicProvider } from './anthropic.js'
export type { AnthropicOptions } from './anthropic.js'
// Multi-provider fallback adapter — falls through to the next adapter on
// 401/403/429, excludes 400 (client fault), applies exponential backoff, and
// respects AbortSignal. Adapter order is re-derived per call rather than held
// in a shared mutable cursor, so concurrent calls cannot race.
export { ProviderFallbackAdapter } from './fallback-provider.js'
export type { FallbackAdapterOptions } from './fallback-provider.js'
