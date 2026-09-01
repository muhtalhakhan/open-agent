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
