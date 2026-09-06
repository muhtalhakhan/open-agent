import { describe, expect, it } from 'vitest'
import { NetworkPolicyError, checkResolvedAddresses, checkUrl, hostMatches, isPrivateHost } from './network-policy.js'

describe('isPrivateHost', () => {
  it.each([
    ['localhost', 'localhost'],
    ['a .localhost subdomain', 'api.localhost'],
    ['an mDNS name', 'printer.local'],
    ['loopback', '127.0.0.1'],
    ['another loopback address', '127.1.2.3'],
    ['RFC1918 10/8', '10.0.0.5'],
    ['RFC1918 172.16/12', '172.20.1.1'],
    ['RFC1918 192.168/16', '192.168.1.1'],
    ['the cloud metadata address', '169.254.169.254'],
    ['CGNAT', '100.64.0.1'],
    ['"this host"', '0.0.0.0'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unique-local', 'fd00::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['an IPv4-mapped loopback', '::ffff:127.0.0.1'],
  ])('treats %s as private', (_label, host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  it.each(['example.com', 'api.github.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', '2606:4700::1111'])(
    'treats %s as public',
    (host) => {
      expect(isPrivateHost(host)).toBe(false)
    },
  )

  it('sees through the brackets a URL puts around an IPv6 host', () => {
    expect(isPrivateHost('[::1]')).toBe(true)
  })
})

describe('checkUrl', () => {
  it('allows an ordinary public URL with no policy at all', () => {
    expect(checkUrl('https://api.github.com/repos').hostname).toBe('api.github.com')
  })

  it.each(['file:///etc/passwd', 'data:text/plain,hi', 'ftp://example.com'])('refuses the %s scheme', (url) => {
    expect(() => checkUrl(url)).toThrow(/unsupported URL scheme/)
  })

  it('refuses a relative URL', () => {
    expect(() => checkUrl('/v1/users')).toThrow(NetworkPolicyError)
  })

  it('refuses the cloud metadata endpoint by default', () => {
    // The reason this file exists. An agent handed a URL by a page it just
    // read will fetch this one as readily as any other.
    expect(() => checkUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/loopback, private or link-local/)
  })

  it.each(['http://localhost:6379', 'http://127.0.0.1:8080', 'http://192.168.1.1/admin', 'http://[::1]:5432'])(
    'refuses %s by default',
    (url) => {
      expect(() => checkUrl(url)).toThrow(/loopback, private or link-local/)
    },
  )

  it('allows local addresses when the operator turns them on', () => {
    expect(checkUrl('http://localhost:3000/api', { allowLocal: true }).hostname).toBe('localhost')
  })

  it('treats naming a local host in the allowlist as permission for that host', () => {
    // Naming it is a decision about that host; it should not require opening
    // up every private address to reach one local API.
    expect(checkUrl('http://localhost:3000/api', { allowedHosts: ['localhost'] }).hostname).toBe('localhost')
    expect(() => checkUrl('http://192.168.1.1/', { allowedHosts: ['localhost'] })).toThrow(/not in the allowed host/)
  })

  it('enforces an allowlist, subdomains included', () => {
    const policy = { allowedHosts: ['example.com'] }
    expect(checkUrl('https://api.example.com/x', policy).hostname).toBe('api.example.com')
    expect(() => checkUrl('https://evil.com/x', policy)).toThrow(/not in the allowed host list/)
  })

  it('is not fooled by a host that merely ends with an allowed name', () => {
    expect(() => checkUrl('https://notexample.com/x', { allowedHosts: ['example.com'] })).toThrow(/not in the allowed/)
  })

  it('lets an empty allowlist permit nothing', () => {
    expect(() => checkUrl('https://example.com', { allowedHosts: [] })).toThrow(/not in the allowed host list/)
  })

  it('checks the denylist before the allowlist', () => {
    const policy = { allowedHosts: ['example.com'], deniedHosts: ['internal.example.com'] }
    expect(() => checkUrl('https://internal.example.com/x', policy)).toThrow(/denied host list/)
    expect(checkUrl('https://api.example.com/x', policy).hostname).toBe('api.example.com')
  })
})

describe('checkResolvedAddresses', () => {
  it('refuses a public name that resolves to a private address', () => {
    // One DNS record is all it costs to defeat the name check alone.
    expect(() => checkResolvedAddresses('metadata.evil.test', ['169.254.169.254'])).toThrow(/resolves to 169.254/)
  })

  it('refuses when any one of several addresses is private', () => {
    expect(() => checkResolvedAddresses('mixed.test', ['93.184.216.34', '127.0.0.1'])).toThrow(/resolves to 127/)
  })

  it('allows a name that resolves entirely to public addresses', () => {
    expect(() => checkResolvedAddresses('example.com', ['93.184.216.34'])).not.toThrow()
  })

  it('stands aside when local addresses are allowed', () => {
    expect(() => checkResolvedAddresses('dev.test', ['127.0.0.1'], { allowLocal: true })).not.toThrow()
  })

  it('stands aside for a host the operator named', () => {
    expect(() => checkResolvedAddresses('dev.test', ['127.0.0.1'], { allowedHosts: ['dev.test'] })).not.toThrow()
  })
})

describe('hostMatches', () => {
  it.each([
    ['example.com', 'example.com', true],
    ['api.example.com', 'example.com', true],
    ['EXAMPLE.com', 'example.com', true],
    ['example.com', '.example.com', true],
    ['notexample.com', 'example.com', false],
    ['example.com.evil.test', 'example.com', false],
  ])('%s against %s is %s', (host, entry, expected) => {
    expect(hostMatches(host, entry)).toBe(expected)
  })
})
