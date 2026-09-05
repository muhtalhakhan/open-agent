import { describe, expect, it } from 'vitest'
import { loadConfigFromEnv } from './config.js'

describe('loadConfigFromEnv', () => {
  it('fails when the required OpenAI-compatible env vars are missing', () => {
    const result = loadConfigFromEnv({})
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/OPENAI_BASE_URL/) })
  })

  it('parses the minimal required config with memory defaulting to none', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
    })
    expect(result).toEqual({
      ok: true,
      config: {
        llm: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x', model: 'gpt-4o-mini' },
        browserUse: false,
        http: { enabled: false, allowedHosts: undefined, secrets: {} },
        search: { provider: 'none' },
        memory: { provider: 'none' },
      },
    })
  })

  it('enables browser-use when BROWSER_USE=1', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      BROWSER_USE: '1',
    })
    expect(result.ok && result.config.browserUse).toBe(true)
  })

  it('leaves the http tool off, unrestricted and secret-free by default', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
    })
    expect(result.ok && result.config.http).toEqual({ enabled: false, allowedHosts: undefined, secrets: {} })
  })

  it('enables the http tool with its allowlist and HTTP_SECRET_* placeholders', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      HTTP_TOOL: '1',
      HTTP_ALLOWED_HOSTS: 'api.stripe.com, api.github.com',
      HTTP_SECRET_STRIPE_KEY: 'sk-live-1',
    })
    expect(result.ok && result.config.http).toEqual({
      enabled: true,
      allowedHosts: ['api.stripe.com', 'api.github.com'],
      secrets: { STRIPE_KEY: 'sk-live-1' },
    })
  })

  it('reads an empty HTTP_ALLOWED_HOSTS as an allowlist of nothing, not as no allowlist', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      HTTP_TOOL: '1',
      HTTP_ALLOWED_HOSTS: '',
    })
    expect(result.ok && result.config.http.allowedHosts).toEqual([])
  })

  it('enables brave web search when BRAVE_SEARCH_API_KEY is set', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      BRAVE_SEARCH_API_KEY: 'brave-1',
    })
    expect(result.ok && result.config.search).toEqual({ provider: 'brave', apiKey: 'brave-1' })
  })

  it('falls back to tavily when only TAVILY_API_KEY is set', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      TAVILY_API_KEY: 'tvly-1',
    })
    expect(result.ok && result.config.search).toEqual({ provider: 'tavily', apiKey: 'tvly-1' })
  })

  it('prefers brave when both search keys are set', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      BRAVE_SEARCH_API_KEY: 'brave-1',
      TAVILY_API_KEY: 'tvly-1',
    })
    expect(result.ok && result.config.search).toEqual({ provider: 'brave', apiKey: 'brave-1' })
  })

  it('picks supermemory when SUPERMEMORY_API_KEY is set', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      SUPERMEMORY_API_KEY: 'sm-key',
    })
    expect(result.ok && result.config.memory).toEqual({ provider: 'supermemory', apiKey: 'sm-key', baseURL: undefined })
  })

  it('picks mem0 when MEM0_API_KEY is set and supermemory is not', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      MEM0_API_KEY: 'm0-key',
    })
    expect(result.ok && result.config.memory).toEqual({ provider: 'mem0', apiKey: 'm0-key' })
  })
})
