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
 * Host vetting moved to `@open-agent/agent`, where the browser and any future
 * proxy can share one rule rather than each growing its own. Re-exported here
 * so the tool keeps a single import for its policy.
 *
 * `HttpPolicyError` stays distinct from `NetworkPolicyError` for the checks
 * that really are HTTP's own — a bad `{{PLACEHOLDER}}`, an oversized body.
 */
export { checkUrl, hostMatches, NetworkPolicyError } from '@open-agent/agent'
export type { NetworkPolicy } from '@open-agent/agent'

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
