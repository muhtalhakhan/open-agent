import { lookup } from 'node:dns/promises'
import { checkResolvedAddresses, checkUrl, type NetworkPolicy } from '@open-agent/agent'

export interface GuardedFetchOptions {
  policy: NetworkPolicy
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch
  /** Resolves a hostname to its addresses; `null` skips the resolved-address check. Defaults to the system resolver. */
  lookupFn?: ((hostname: string) => Promise<string[]>) | null
  /** Redirect hops followed before giving up. Each one is vetted again. */
  maxRedirects: number
}

export class TooManyRedirectsError extends Error {}

/** The 3xx statuses that carry a Location worth following. */
function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * `fetch`, with every URL it will reach vetted against the network policy
 * first: the one it was given and each redirect after it. Shared by every
 * tool that fetches a URL the model chose, so the rule cannot drift between
 * them.
 *
 * The name is checked, then what it resolves to — the second is what stops
 * `metadata.evil.test A 169.254.169.254`, which costs an attacker one DNS
 * record and defeats the name check alone. Redirects are followed by hand:
 * following automatically would let one redirect to 169.254.169.254 undo the
 * check the first URL just passed.
 */
export function createGuardedFetch(options: GuardedFetchOptions) {
  const resolveHost =
    options.lookupFn === null
      ? null
      : (options.lookupFn ??
        (async (hostname: string) => (await lookup(hostname, { all: true })).map((entry) => entry.address)))

  const vet = async (target: string): Promise<void> => {
    const parsed = checkUrl(target, options.policy)
    if (!resolveHost) return
    let addresses: string[]
    try {
      addresses = await resolveHost(parsed.hostname)
    } catch {
      // A name that does not resolve is the fetch's problem to report, and
      // its error message is better than anything invented here.
      return
    }
    checkResolvedAddresses(parsed.hostname, addresses, options.policy)
  }

  return {
    vet,
    /** Resolves to the final response and the URL it came from. Policy refusals throw. */
    async fetch(url: string, init: Omit<RequestInit, 'redirect'>): Promise<{ response: Response; url: string }> {
      const fetchFn = options.fetchFn ?? fetch
      await vet(url)
      let response = await fetchFn(url, { ...init, redirect: 'manual' })
      let hops = 0
      while (isRedirect(response.status)) {
        const location = response.headers.get('location')
        if (!location) break
        if (hops >= options.maxRedirects) {
          throw new TooManyRedirectsError(`too many redirects (stopped after ${options.maxRedirects})`)
        }
        const next = new URL(location, url).toString()
        await vet(next)
        url = next
        hops += 1
        response = await fetchFn(url, { ...init, redirect: 'manual' })
      }
      return { response, url }
    },
  }
}
