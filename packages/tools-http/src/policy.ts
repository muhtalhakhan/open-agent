/**
 * The two guard rails the HTTP tool needs and that nothing else in the repo
 * provides yet: an outbound-host allowlist (the local stand-in for the
 * per-profile network restrictions of #89) and secret placeholders, so an
 * auth header can be sent without the key ever entering the model's context
 * (#88). Both are pure functions, and are kept apart from the tool itself so
 * the policy can be tested without going near fetch.
 */

/** `{{NAME}}` — the placeholder the model writes where a credential belongs. */
const PLACEHOLDER = /\{\{([A-Za-z0-9_.-]+)\}\}/g

export class HttpPolicyError extends Error {}

/**
 * Matches a hostname against an allowlist entry. `example.com` covers
 * `example.com` and any subdomain of it; that is the usual reading of an
 * allowlist entry, and pinning a single host is still possible by listing
 * the exact subdomain and nothing above it.
 */
function hostMatches(hostname: string, entry: string): boolean {
  const host = hostname.toLowerCase()
  const allowed = entry.toLowerCase().replace(/^\./, '')
  return host === allowed || host.endsWith(`.${allowed}`)
}

/**
 * Parses and vets a URL. Only http(s) survives: `file:`, `data:` and the
 * rest are not "an API" and would hand the model a filesystem read through
 * a tool that is not meant to have one.
 */
export function checkUrl(url: string, allowedHosts?: readonly string[]): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new HttpPolicyError(`"${url}" is not a valid absolute URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpPolicyError(`unsupported URL scheme "${parsed.protocol}" — only http and https are allowed`)
  }
  if (allowedHosts && !allowedHosts.some((entry) => hostMatches(parsed.hostname, entry))) {
    throw new HttpPolicyError(
      `host "${parsed.hostname}" is not in the allowed host list (${allowedHosts.join(', ') || 'empty'})`,
    )
  }
  return parsed
}

/**
 * Substitutes `{{NAME}}` with the secret's value. An unknown name is an
 * error rather than a silent empty string — a request sent with a blank
 * credential fails somewhere far less legible. The message lists the
 * available names only; values never leave this module.
 */
export function resolveSecrets(text: string, secrets: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = secrets[name]
    if (value === undefined) {
      const known = Object.keys(secrets)
      throw new HttpPolicyError(
        `unknown secret "${name}" — available: ${known.length ? known.join(', ') : '(none configured)'}`,
      )
    }
    return value
  })
}

/**
 * Puts the placeholder back wherever a secret's value appears, so nothing
 * that is echoed to the model or the audit log carries the raw credential —
 * not the request line, not an error message quoting the URL, not a
 * response body that reflects the header back.
 */
export function redactSecrets(text: string, secrets: Readonly<Record<string, string>>): string {
  let redacted = text
  for (const [name, value] of Object.entries(secrets)) {
    if (value) redacted = redacted.split(value).join(`{{${name}}}`)
  }
  return redacted
}
