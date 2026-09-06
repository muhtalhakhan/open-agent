import { describe, expect, it } from 'vitest'
import { apiKeyVarsFor, resolveCredential } from './credentials.js'

/** Every test injects `readFile`, so nothing here touches the disk. */
const files = (contents: Record<string, string>) => (path: string) => {
  const found = contents[path]
  if (found === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
  return found
}

describe('resolveCredential', () => {
  it('reads the value straight from the named variable', () => {
    expect(resolveCredential('OPENAI_API_KEY', { env: { OPENAI_API_KEY: 'sk-live-1' } })).toEqual({
      ok: true,
      value: 'sk-live-1',
      source: 'OPENAI_API_KEY',
    })
  })

  it('falls back to <NAME>_FILE and trims the trailing newline a secret file carries', () => {
    const result = resolveCredential('OPENAI_API_KEY', {
      env: { OPENAI_API_KEY_FILE: '/run/secrets/openai' },
      readFile: files({ '/run/secrets/openai': 'sk-live-1\n' }),
    })
    expect(result).toEqual({ ok: true, value: 'sk-live-1', source: 'OPENAI_API_KEY_FILE (/run/secrets/openai)' })
  })

  it('prefers the direct variable over the file when both are set', () => {
    const result = resolveCredential('OPENAI_API_KEY', {
      env: { OPENAI_API_KEY: 'sk-direct', OPENAI_API_KEY_FILE: '/run/secrets/openai' },
      readFile: files({ '/run/secrets/openai': 'sk-from-file' }),
    })
    expect(result.ok && result.value).toBe('sk-direct')
  })

  it('tries each name in order and stops at the first one configured', () => {
    const result = resolveCredential(['OPENROUTER_API_KEY', 'OPENAI_API_KEY'], {
      env: { OPENAI_API_KEY: 'sk-generic' },
    })
    expect(result.ok && result.source).toBe('OPENAI_API_KEY')
  })

  it('lets an earlier name win over a later one', () => {
    const result = resolveCredential(['OPENROUTER_API_KEY', 'OPENAI_API_KEY'], {
      env: { OPENROUTER_API_KEY: 'or-1', OPENAI_API_KEY: 'sk-generic' },
    })
    expect(result.ok && result.value).toBe('or-1')
  })

  it.each([
    ['unset', {}],
    ['empty', { OPENAI_API_KEY: '' }],
    ['whitespace only', { OPENAI_API_KEY: '   ' }],
  ])('reports a %s variable as missing rather than as a configured empty key', (_label, env) => {
    const result = resolveCredential('OPENAI_API_KEY', { env })
    expect(result).toEqual({ ok: false, reason: 'missing', error: expect.stringContaining('OPENAI_API_KEY') })
  })

  it('names the _FILE variant in the missing-credential error', () => {
    const result = resolveCredential('OPENAI_API_KEY', { env: {} })
    expect(!result.ok && result.error).toContain('OPENAI_API_KEY_FILE')
  })

  it('lists every accepted name when several were offered', () => {
    const result = resolveCredential(['OPENROUTER_API_KEY', 'OPENAI_API_KEY'], { env: {} })
    expect(!result.ok && result.error).toBe(
      'Set OPENROUTER_API_KEY or OPENAI_API_KEY (or OPENROUTER_API_KEY_FILE to read the value from a file).',
    )
  })

  it('reports an unreadable file instead of falling through to the next name', () => {
    const result = resolveCredential(['OPENROUTER_API_KEY', 'OPENAI_API_KEY'], {
      env: { OPENROUTER_API_KEY_FILE: '/run/secrets/typo', OPENAI_API_KEY: 'sk-generic' },
      readFile: files({}),
    })
    expect(result).toEqual({
      ok: false,
      reason: 'unreadable',
      error: expect.stringContaining('/run/secrets/typo'),
    })
  })

  it('reports an empty file rather than handing back an empty key', () => {
    const result = resolveCredential('OPENAI_API_KEY', {
      env: { OPENAI_API_KEY_FILE: '/run/secrets/openai' },
      readFile: files({ '/run/secrets/openai': '\n' }),
    })
    expect(result).toEqual({ ok: false, reason: 'malformed', error: expect.stringContaining('is empty') })
  })

  it.each([
    ['an embedded CRLF, which would split a request header', 'sk-live\r\nX-Injected: 1'],
    ['an interior space', 'sk live'],
    ['a control character', 'sk-live\u0007key'],
  ])('rejects a key with %s', (_label, value) => {
    const result = resolveCredential('OPENAI_API_KEY', { env: { OPENAI_API_KEY: value } })
    expect(result).toEqual({ ok: false, reason: 'malformed', error: expect.stringContaining('OPENAI_API_KEY') })
  })

  it('never echoes the value in an error', () => {
    const result = resolveCredential('OPENAI_API_KEY', { env: { OPENAI_API_KEY: 'sk-live-secret oops' } })
    expect(!result.ok && result.error).not.toContain('sk-live-secret')
  })
})

describe('apiKeyVarsFor', () => {
  it.each([
    ['https://openrouter.ai/api/v1', ['OPENROUTER_API_KEY', 'OPENAI_API_KEY']],
    ['https://api.anthropic.com/v1', ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']],
    ['https://generativelanguage.googleapis.com/v1beta', ['GEMINI_API_KEY', 'OPENAI_API_KEY']],
  ])('offers the vendor spelling first for %s', (baseURL, expected) => {
    expect(apiKeyVarsFor(baseURL)).toEqual(expected)
  })

  it.each([
    'https://api.openai.com/v1',
    'http://localhost:11434/v1',
    // A host that merely ends in the vendor's name is not that vendor.
    'https://notopenrouter.ai/v1',
  ])('offers only the generic name for %s', (baseURL) => {
    expect(apiKeyVarsFor(baseURL)).toEqual(['OPENAI_API_KEY'])
  })

  it('falls back to the generic name for an unparseable base URL', () => {
    expect(apiKeyVarsFor('not a url')).toEqual(['OPENAI_API_KEY'])
  })
})
