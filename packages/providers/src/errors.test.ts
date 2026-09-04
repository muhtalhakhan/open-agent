import { describe, expect, it } from 'vitest'
import { ProviderHttpError, redactUrl } from './errors.js'

describe('redactUrl', () => {
  it.each([
    ['https://x.test/v1?key=AIzaSecret', 'https://x.test/v1?key=[REDACTED]'],
    ['https://x.test/v1?alt=sse&api_key=sk-live-123', 'https://x.test/v1?alt=sse&api_key=[REDACTED]'],
    ['https://x.test/v1?apikey=sk-live-123', 'https://x.test/v1?apikey=[REDACTED]'],
    ['https://x.test/v1?access_token=ya29.abc', 'https://x.test/v1?access_token=[REDACTED]'],
    ['https://x.test/v1?token=abc', 'https://x.test/v1?token=[REDACTED]'],
    ['https://x.test/v1?KEY=AIzaSecret', 'https://x.test/v1?KEY=[REDACTED]'],
    // Azure OpenAI's canonical spelling.
    ['https://f.openai.azure.com/chat?api-key=sk-secret', 'https://f.openai.azure.com/chat?api-key=[REDACTED]'],
    ['https://x.test/v1?x-goog-api-key=AIzaSecret', 'https://x.test/v1?x-goog-api-key=[REDACTED]'],
    ['https://x.test/v1?access-token=ya29.abc', 'https://x.test/v1?access-token=[REDACTED]'],
  ])('redacts %s', (raw, expected) => {
    expect(redactUrl(raw)).toBe(expected)
  })

  it('keeps non-credential parameters intact', () => {
    expect(redactUrl('https://x.test/v1?model=gemini-2.0-flash&key=AIzaSecret&alt=sse')).toBe(
      'https://x.test/v1?model=gemini-2.0-flash&key=[REDACTED]&alt=sse',
    )
  })

  it('leaves a URL without credentials unchanged', () => {
    expect(redactUrl('https://api.anthropic.com/v1/messages')).toBe('https://api.anthropic.com/v1/messages')
  })

  it.each(['https://x.test/v1?monkey=banana', 'https://x.test/v1?tokenizer=bpe'])(
    'does not redact a parameter that merely contains a credential word (%s)',
    (raw) => {
      expect(redactUrl(raw)).toBe(raw)
    },
  )
})

describe('ProviderHttpError', () => {
  it('exposes the status as a field instead of only in the message', () => {
    const err = new ProviderHttpError(429, 'gemini', 'https://x.test/v1', 'slow down')

    expect(err.status).toBe(429)
    expect(err.provider).toBe('gemini')
    expect(err.name).toBe('ProviderHttpError')
    expect(err).toBeInstanceOf(Error)
  })

  it('names the provider in the message', () => {
    const err = new ProviderHttpError(401, 'anthropic', 'https://api.anthropic.com/v1/messages', 'Unauthorized')

    expect(err.message).toBe('anthropic: https://api.anthropic.com/v1/messages responded 401: Unauthorized')
  })

  it('redacts credentials in the url', () => {
    const err = new ProviderHttpError(400, 'gemini', 'https://x.test/v1?key=AIzaSecret', 'Bad Request')

    expect(err.url).toBe('https://x.test/v1?key=[REDACTED]')
    expect(err.message).not.toContain('AIzaSecret')
  })

  it('redacts credentials the provider echoes back in the body', () => {
    const err = new ProviderHttpError(
      400, 'gemini', 'https://x.test/v1', '{"error":"bad request for https://x.test/v1?key=AIzaSecret"}',
    )

    expect(err.body).not.toContain('AIzaSecret')
    expect(err.message).not.toContain('AIzaSecret')
    expect(err.body).toContain('key=[REDACTED]')
  })
})
