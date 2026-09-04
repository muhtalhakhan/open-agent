/**
 * Strips credentials that providers accept as query parameters. Gemini takes
 * the API key as `?key=`, so a raw URL in an error message would put a live
 * key into logs and stack traces. Redacting centrally rather than at each
 * throw site means a new adapter cannot forget to do it.
 *
 * Applied to response bodies as well as URLs: providers routinely echo the
 * failing request URL back in their error payloads, which would otherwise
 * reintroduce the key the URL redaction just removed.
 */

/**
 * Matches a credential query parameter and its value.
 *
 * The optional `(?:[a-z0-9]+[-_])*` prefix catches vendor-namespaced spellings
 * — Azure OpenAI uses `api-key`, Google uses `x-goog-api-key` — while still
 * requiring a `-`/`_` boundary before the keyword, so `?monkey=banana` is left
 * alone. The value stops at `&`, whitespace, or a quote: bodies embed URLs
 * inside JSON strings, and `[^&]+` there would swallow the rest of the payload.
 */
const CREDENTIAL_PARAM = /([?&](?:[a-z0-9]+[-_])*(?:api[-_]?key|access[-_]?token|key|token)=)[^&\s"']+/gi

export function redactUrl(url: string): string {
  return url.replace(CREDENTIAL_PARAM, '$1[REDACTED]')
}

/**
 * Error thrown by every provider adapter when the upstream API returns a
 * non-OK response.
 *
 * The status is carried as a field rather than only formatted into the
 * message, so consumers that need to branch on it — `ProviderFallbackAdapter`
 * most of all — can read `err.status` instead of parsing prose that no
 * provider promised to keep stable.
 */
export class ProviderHttpError extends Error {
  override readonly name = 'ProviderHttpError'

  /** HTTP status returned by the provider. */
  readonly status: number
  /** Adapter that issued the request, e.g. `gemini`. */
  readonly provider: string
  /** Request URL, with credentials redacted. */
  readonly url: string
  /** Response body, with credentials redacted. */
  readonly body: string

  constructor(status: number, provider: string, url: string, body: string) {
    const safeUrl = redactUrl(url)
    const safeBody = redactUrl(body)
    super(`${provider}: ${safeUrl} responded ${status}: ${safeBody}`)
    this.status = status
    this.provider = provider
    this.url = safeUrl
    this.body = safeBody
  }
}
