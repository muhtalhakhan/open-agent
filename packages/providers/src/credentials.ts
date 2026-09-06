/**
 * Credential resolution for provider API keys and any other secret a package
 * needs at construction time.
 *
 * Two things distinguish this from reading `process.env` directly:
 *
 * 1. `<NAME>_FILE` indirection. Docker secrets, Kubernetes secret volumes and
 *    systemd's `LoadCredential=` all deliver a credential as a file, not an
 *    environment variable, because an env var is readable by every child
 *    process and shows up in `/proc/<pid>/environ`. Supporting the `_FILE`
 *    convention means those deployments do not have to shell out to `cat`.
 * 2. Validation that never echoes the value. A key with an embedded newline
 *    would otherwise be smuggled into a request header, so it is rejected
 *    here — and the rejection names the variable it came from, never the
 *    value, because config errors are exactly the strings that end up in logs
 *    and issue reports.
 */
import { readFileSync } from 'node:fs'

export interface CredentialLookup {
  env: NodeJS.ProcessEnv
  /** Injectable for tests; defaults to reading the path as UTF-8. */
  readFile?: (path: string) => string
}

export type CredentialResult =
  | { ok: true; value: string; source: string }
  /**
   * `missing` means nothing was configured, which callers holding an optional
   * credential can ignore. `unreadable` and `malformed` mean the operator
   * tried to supply one and it did not work — always worth failing on, rather
   * than silently running as if the feature had never been enabled.
   */
  | { ok: false; reason: 'missing' | 'unreadable' | 'malformed'; error: string }

/**
 * Anything that cannot legally appear in an HTTP header value or a query
 * parameter. Matching control characters is the whole point of the check, so
 * the lint rule that forbids them in a pattern does not apply here.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_IN_CREDENTIAL = /[\s\u0000-\u001F\u007F]/

/**
 * Resolves the first configured credential among `names`, trying `<NAME>` and
 * then `<NAME>_FILE` for each before moving on to the next name. Earlier names
 * win, so callers list the most specific variable first.
 *
 * An empty or whitespace-only variable counts as unset: `.env` files routinely
 * carry `SOME_API_KEY=` placeholders, and treating those as a configured empty
 * key would turn a missing-credential error into a 401 from the provider.
 */
export function resolveCredential(names: string | string[], lookup: CredentialLookup): CredentialResult {
  const candidates = typeof names === 'string' ? [names] : names

  for (const name of candidates) {
    const direct = lookup.env[name]
    if (direct !== undefined && direct.trim() !== '') return validate(direct, name)

    const fileVar = `${name}_FILE`
    const rawPath = lookup.env[fileVar]
    if (rawPath === undefined || rawPath.trim() === '') continue

    const filePath = rawPath.trim()
    const read = lookup.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
    let contents: string
    try {
      contents = read(filePath)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        reason: 'unreadable',
        error: `${fileVar} points at ${filePath}, which could not be read: ${detail}`,
      }
    }
    if (contents.trim() === '') {
      return { ok: false, reason: 'malformed', error: `${fileVar} points at ${filePath}, which is empty.` }
    }
    return validate(contents, `${fileVar} (${filePath})`)
  }

  const listed = candidates.join(' or ')
  return {
    ok: false,
    reason: 'missing',
    error: `Set ${listed} (or ${candidates[0]}_FILE to read the value from a file).`,
  }
}

/**
 * Trailing newlines are the norm for secret files — `echo` adds one, and so do
 * most editors — so the value is trimmed rather than rejected for it. What
 * survives the trim must still be a single clean token: interior whitespace or
 * a control character means the file holds something other than a bare key
 * (a shell line, a JSON blob, a CRLF pair), and sending it on as a header
 * would be a request-splitting bug rather than a 401.
 */
function validate(raw: string, source: string): CredentialResult {
  const value = raw.trim()
  if (ILLEGAL_IN_CREDENTIAL.test(value)) {
    return {
      ok: false,
      reason: 'malformed',
      error: `${source} contains whitespace or control characters; it should hold the credential and nothing else.`,
    }
  }
  return { ok: true, value, source }
}

/**
 * Vendor-specific spellings of "the API key", keyed by the host the base URL
 * points at. `OPENAI_API_KEY` works everywhere because the adapter speaks the
 * OpenAI wire format regardless of who is behind it, but an operator pointed
 * at OpenRouter reaches for `OPENROUTER_API_KEY` first, so accept both.
 */
const VENDOR_API_KEY_VARS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)openrouter\.ai$/i, 'OPENROUTER_API_KEY'],
  [/(^|\.)anthropic\.com$/i, 'ANTHROPIC_API_KEY'],
  [/(^|\.)googleapis\.com$/i, 'GEMINI_API_KEY'],
]

/**
 * Candidate API-key variables for a base URL, most specific first. An
 * unparseable URL yields the generic name alone; reporting the failure is the
 * caller's job, since a bad base URL is a config error in its own right.
 */
export function apiKeyVarsFor(baseURL: string): string[] {
  let host: string
  try {
    host = new URL(baseURL).hostname
  } catch {
    return ['OPENAI_API_KEY']
  }
  const vendor = VENDOR_API_KEY_VARS.find(([pattern]) => pattern.test(host))?.[1]
  return vendor ? [vendor, 'OPENAI_API_KEY'] : ['OPENAI_API_KEY']
}
