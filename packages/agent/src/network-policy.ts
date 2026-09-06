/**
 * Where the agent is allowed to make requests.
 *
 * The allowlist half of this is the obvious half. The half that matters more
 * is what happens when there is no allowlist, which is the documented default:
 * an agent that fetches a URL will fetch `http://169.254.169.254/latest/
 * meta-data/iam/security-credentials/` just as readily as a public API, and
 * hand back the cloud credentials as tool output. The same goes for
 * `http://localhost:6379` and anything else listening on the host that assumed
 * it was unreachable from outside.
 *
 * That is not a hypothetical for an agent in particular. The URL frequently
 * comes from a page it just read, so "the attacker picks the URL" is the
 * ordinary case rather than the exotic one. Private, loopback and link-local
 * destinations are therefore refused unless someone says otherwise — the one
 * default here that is deny rather than allow.
 *
 * Lives in this package for the same reason `filterEnv` does: more than one
 * tool needs it, and a security rule with two copies drifts.
 */

export class NetworkPolicyError extends Error {
  override readonly name = 'NetworkPolicyError'
}

export interface NetworkPolicy {
  /** Hosts the agent may reach. Unset means any host, subject to the rules below. */
  allowedHosts?: readonly string[]
  /** Hosts refused outright, checked before the allowlist. */
  deniedHosts?: readonly string[]
  /**
   * Permit loopback, private and link-local destinations. Off by default.
   * A local development API is a legitimate reason to turn it on; the cloud
   * metadata endpoint is the reason it is not on already.
   */
  allowLocal?: boolean
}

/**
 * Matches a hostname against a list entry. `example.com` covers `example.com`
 * and any subdomain of it; that is the usual reading of such a list, and
 * pinning one host is still possible by naming the exact subdomain.
 */
export function hostMatches(hostname: string, entry: string): boolean {
  const host = hostname.toLowerCase()
  const allowed = entry.toLowerCase().replace(/^\./, '')
  return host === allowed || host.endsWith(`.${allowed}`)
}

/** Strips the brackets a URL puts around a literal IPv6 host. */
function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [a, b] = octets

  if (a === 127) return true // loopback
  if (a === 10) return true // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 169 && b === 254) return true // link-local, and the cloud metadata address
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 0) return true // "this host"
  return false
}

function isPrivateIpv6(address: string): boolean {
  const host = address.toLowerCase().split('%')[0] // drop a zone index
  if (host === '::1' || host === '::') return true
  // IPv4-mapped (::ffff:127.0.0.1) is the same destination wearing a hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
  if (mapped) return isPrivateIpv4(mapped[1])
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true // unique local, fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true // link-local, fe80::/10
  return false
}

/**
 * Whether a host names this machine or a private network.
 *
 * Covers literal addresses and the names that conventionally resolve to one.
 * It cannot cover a public name that resolves to a private address — that
 * needs DNS, which belongs with the caller that is about to connect.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = bareHost(hostname).toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host)
  if (host.includes(':')) return isPrivateIpv6(host)
  return false
}

/**
 * Vets a URL against the policy, returning it parsed.
 *
 * Only http(s) survives: `file:` and `data:` are not "an API", and would hand
 * the model a filesystem read through a tool that is not meant to have one.
 */
export function checkUrl(url: string, policy: NetworkPolicy = {}): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new NetworkPolicyError(`"${url}" is not a valid absolute URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NetworkPolicyError(`unsupported URL scheme "${parsed.protocol}" — only http and https are allowed`)
  }

  const hostname = bareHost(parsed.hostname)

  if (policy.deniedHosts?.some((entry) => hostMatches(hostname, entry))) {
    throw new NetworkPolicyError(`host "${hostname}" is on the denied host list`)
  }

  // An explicit allowlist entry is a decision about that host, so naming
  // `localhost` is how a local API is reached without opening up every
  // private address.
  const explicitlyAllowed = policy.allowedHosts?.some((entry) => hostMatches(hostname, entry)) ?? false

  if (policy.allowedHosts && !explicitlyAllowed) {
    throw new NetworkPolicyError(
      `host "${hostname}" is not in the allowed host list (${policy.allowedHosts.join(', ') || 'empty'})`,
    )
  }

  if (isPrivateHost(hostname) && !policy.allowLocal && !explicitlyAllowed) {
    throw new NetworkPolicyError(
      `host "${hostname}" is a loopback, private or link-local address; ` +
        'these are refused by default because they reach services on the host that assumed they were unreachable. ' +
        'Allow it by name or set allowLocal.',
    )
  }

  return parsed
}

/**
 * Checks addresses a hostname actually resolved to.
 *
 * The name check above is defeated by a public name pointing at a private
 * address — `metadata.evil.test A 169.254.169.254` costs an attacker one DNS
 * record. Resolution belongs to whoever is about to connect, so they pass the
 * addresses back here.
 *
 * This narrows the hole rather than closing it: a name re-resolved between
 * this check and the connection can still change (DNS rebinding), which is
 * only truly fixed by pinning the address that was checked and connecting to
 * that.
 */
export function checkResolvedAddresses(
  hostname: string,
  addresses: readonly string[],
  policy: NetworkPolicy = {},
): void {
  if (policy.allowLocal) return
  if (policy.allowedHosts?.some((entry) => hostMatches(bareHost(hostname), entry))) return

  const offender = addresses.find((address) => isPrivateHost(address))
  if (offender) {
    throw new NetworkPolicyError(
      `host "${hostname}" resolves to ${offender}, a loopback, private or link-local address; ` +
        'refused because a public name pointing at a private address is how the check above gets bypassed.',
    )
  }
}
