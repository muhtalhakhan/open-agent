import { describe, expect, it } from 'vitest'
import { FilePolicyError, checkAccess, isDenied } from './file-policy.js'

describe('isDenied', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    'packages/api/.env',
    'certs/server.pem',
    'server.key',
    'keystore.jks',
    'id_rsa',
    '.ssh/id_ed25519',
    '.ssh/deep/nested',
    '.aws/credentials',
    '.kube/config',
    '.npmrc',
    '.netrc',
    '.git-credentials',
    '.git/config',
    'credentials.json',
    'secrets.yaml',
  ])('denies %s by default', (relative) => {
    expect(isDenied(relative)).toBe(true)
  })

  it.each([
    'src/index.ts',
    'README.md',
    'package.json',
    'environment.ts',
    // A public key is not a secret.
    'id_rsa.pub',
    // The name contains "credentials" but is not the credentials file.
    'src/credentials-form.tsx',
  ])('allows %s', (relative) => {
    expect(isDenied(relative)).toBe(false)
  })

  it.each(['.env.example', '.env.sample', '.env.template', 'docs/.env.example'])(
    'carves %s back out: it is a template of names, not values',
    (relative) => {
      expect(isDenied(relative)).toBe(false)
    },
  )

  it('matches case-insensitively, since the filesystem may not care', () => {
    expect(isDenied('.ENV')).toBe(true)
  })

  it('is not satisfied by a basename when the pattern names a directory', () => {
    // `.aws/credentials` is denied; a stray file called `credentials` is not.
    expect(isDenied('credentials')).toBe(false)
    expect(isDenied('.aws/credentials')).toBe(true)
  })

  it('takes extra deny patterns from the caller', () => {
    expect(isDenied('internal/notes.md', { deny: ['internal/**'] })).toBe(true)
  })

  it('lets an allow pattern win over a deny, including a default one', () => {
    expect(isDenied('.env', { allow: ['.env'] })).toBe(false)
    expect(isDenied('internal/ok.md', { deny: ['internal/**'], allow: ['internal/ok.md'] })).toBe(false)
  })

  it('drops the built-ins when asked, leaving only what the caller said', () => {
    expect(isDenied('.env', { noDefaults: true })).toBe(false)
    expect(isDenied('.env', { noDefaults: true, deny: ['.env'] })).toBe(true)
  })

  it('never denies the workspace root itself', () => {
    expect(isDenied('')).toBe(false)
  })
})

describe('checkAccess', () => {
  it('passes an ordinary file through for both modes', () => {
    expect(() => checkAccess('src/index.ts', 'read')).not.toThrow()
    expect(() => checkAccess('src/index.ts', 'write')).not.toThrow()
  })

  it.each(['read', 'write'] as const)('refuses a denied path on %s', (mode) => {
    expect(() => checkAccess('.env', mode)).toThrow(FilePolicyError)
  })

  it('names the path and the policy, so a refusal is not mistaken for a missing file', () => {
    expect(() => checkAccess('.env', 'read')).toThrow(/^".env" is excluded by the workspace file policy$/)
  })

  it('refuses every write when the workspace is read-only', () => {
    expect(() => checkAccess('src/index.ts', 'write', { readOnly: true })).toThrow('the workspace is read-only')
    expect(() => checkAccess('src/index.ts', 'read', { readOnly: true })).not.toThrow()
  })
})
