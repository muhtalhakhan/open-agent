import { describe, expect, it } from 'vitest'
import { HttpPolicyError, checkUrl, redactSecrets, resolveSecrets } from './policy.js'

describe('checkUrl', () => {
  it('rejects anything that is not http(s)', () => {
    expect(() => checkUrl('file:///etc/passwd')).toThrow(/unsupported URL scheme/)
    expect(() => checkUrl('data:text/plain,hi')).toThrow(/unsupported URL scheme/)
  })

  it('rejects a non-absolute URL', () => {
    expect(() => checkUrl('/v1/users')).toThrow(HttpPolicyError)
  })

  it('allows any host when no allowlist is configured', () => {
    expect(checkUrl('https://example.com/x').hostname).toBe('example.com')
  })

  it('matches an allowlist entry exactly and by subdomain', () => {
    expect(checkUrl('https://api.example.com/x', ['example.com']).hostname).toBe('api.example.com')
    expect(checkUrl('https://example.com/x', ['example.com']).hostname).toBe('example.com')
    expect(() => checkUrl('https://evil.com/x', ['example.com'])).toThrow(/not in the allowed host list/)
  })

  it('does not let a lookalike host pass as a subdomain', () => {
    expect(() => checkUrl('https://notexample.com/x', ['example.com'])).toThrow(/not in the allowed host list/)
  })

  it('allows nothing when the allowlist is empty', () => {
    expect(() => checkUrl('https://example.com', [])).toThrow(/not in the allowed host list/)
  })
})

describe('resolveSecrets', () => {
  it('substitutes placeholders', () => {
    expect(resolveSecrets('Bearer {{TOKEN}}', { TOKEN: 'sk-1' })).toBe('Bearer sk-1')
  })

  it('names the available secrets but never their values on an unknown one', () => {
    try {
      resolveSecrets('{{NOPE}}', { TOKEN: 'sk-1' })
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).toContain('TOKEN')
      expect((err as Error).message).not.toContain('sk-1')
    }
  })

  it('leaves text without placeholders alone', () => {
    expect(resolveSecrets('https://example.com/a{b}c', {})).toBe('https://example.com/a{b}c')
  })
})

describe('redactSecrets', () => {
  it('puts the placeholder back wherever the value appears', () => {
    expect(redactSecrets('sent sk-1 and got sk-1 back', { TOKEN: 'sk-1' })).toBe(
      'sent {{TOKEN}} and got {{TOKEN}} back',
    )
  })

  it('ignores empty values rather than redacting every character', () => {
    expect(redactSecrets('abc', { EMPTY: '' })).toBe('abc')
  })
})
