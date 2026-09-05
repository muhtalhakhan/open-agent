import type { ToolDefinition, ToolResult } from '@open-agent/agent'
import { HttpPolicyError, checkUrl, redactSecrets, resolveSecrets } from './policy.js'
import { formatResponse, readCappedBody } from './response.js'

/** Enough to answer with a page of JSON, small enough not to evict the conversation. */
const DEFAULT_MAX_RESPONSE_BYTES = 64_000
const DEFAULT_TIMEOUT_MS = 30_000

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
type Method = (typeof METHODS)[number]

export interface HttpToolOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch
  /**
   * Hosts the tool may reach, as `api.example.com` or `example.com` (which
   * also covers its subdomains). Omit for no restriction; pass `[]` to allow
   * nothing. This is the local stand-in until profile-level network
   * restrictions land.
   */
  allowedHosts?: readonly string[]
  /**
   * Credentials the model may reference as `{{NAME}}` in the URL, a header,
   * or the body. Values are substituted at execution time and redacted from
   * everything the tool returns, so a token can be used without ever being
   * written into the transcript.
   */
  secrets?: Readonly<Record<string, string>>
  /** Body bytes read before the response is cut off (default 64000). */
  maxResponseBytes?: number
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number
}

type HttpRequestArgs = {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

const SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Absolute http(s) URL, including any query string.' },
    method: { type: 'string', enum: [...METHODS], description: 'HTTP method (default GET).' },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description:
        'Request headers. Write a credential as the placeholder {{SECRET_NAME}}; it is substituted at send time.',
    },
    body: {
      type: 'string',
      description: 'Request body, already serialised (e.g. a JSON string). Not valid on GET/HEAD.',
    },
  },
  required: ['url'],
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

function parseMethod(raw: string | undefined): Method {
  const method = (raw ?? 'GET').toUpperCase()
  if (!(METHODS as readonly string[]).includes(method)) {
    throw new HttpPolicyError(`unsupported method "${method}" — one of ${METHODS.join(', ')}`)
  }
  return method as Method
}

/**
 * A direct HTTP request to an arbitrary API — the fallback for services with
 * no MCP server and no catalog entry, deliberately distinct from those
 * structured integrations.
 *
 * `ask` permission, and not configurable: the tool's whole point is reaching
 * a service the runtime knows nothing about, so neither the request's effect
 * (a POST that charges a card) nor its destination (an endpoint that receives
 * whatever the model was told to send it) can be judged in advance. The host
 * allowlist narrows where it can go; it does not make a call safe to run
 * unattended. See docs/security-model.md.
 */
export function httpRequestTool(options: HttpToolOptions = {}): ToolDefinition<HttpRequestArgs> {
  const secrets = options.secrets ?? {}
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const secretNames = Object.keys(secrets)

  return {
    name: 'http_request',
    description:
      'Make an HTTP request to an arbitrary REST/HTTP API and return the status, headers and body. Use it for services that have no dedicated tool.' +
      (secretNames.length
        ? ` Available credential placeholders: ${secretNames.map((n) => `{{${n}}}`).join(', ')}.`
        : '') +
      (options.allowedHosts ? ` Reachable hosts: ${options.allowedHosts.join(', ') || '(none)'}.` : ''),
    schema: SCHEMA,
    permissionLevel: 'ask',
    async execute(args, context) {
      const fetchFn = options.fetchFn ?? fetch

      let method: Method
      let url: string
      let headers: Record<string, string>
      let body: string | undefined
      try {
        if (typeof args.url !== 'string' || !args.url) return fail('url is required')
        method = parseMethod(args.method)
        url = resolveSecrets(args.url, secrets)
        checkUrl(url, options.allowedHosts)
        headers = Object.fromEntries(
          Object.entries(args.headers ?? {}).map(([name, value]) => [name, resolveSecrets(String(value), secrets)]),
        )
        body = args.body === undefined ? undefined : resolveSecrets(args.body, secrets)
        if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
          return fail(`a ${method} request cannot carry a body`)
        }
      } catch (err) {
        return fail(redactSecrets(err instanceof Error ? err.message : String(err), secrets))
      }

      // The caller's cancellation and our own timeout both have to reach the
      // same request, and the timer has to be cleared however the call ends.
      const controller = new AbortController()
      const onAbort = () => controller.abort(context.signal.reason)
      if (context.signal.aborted) onAbort()
      context.signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs)

      try {
        const response = await fetchFn(url, { method, headers, body, signal: controller.signal, redirect: 'follow' })
        const read = await readCappedBody(response, maxResponseBytes)
        const content = redactSecrets(formatResponse(response, read), secrets)
        // A 4xx/5xx is a real answer, not a tool failure — the model gets the
        // body either way, and `error` says the request did not succeed.
        return response.ok ? { ok: true, content } : { ok: false, content, error: `HTTP ${response.status}` }
      } catch (err) {
        const reason = controller.signal.aborted && !context.signal.aborted ? controller.signal.reason : err
        return fail(redactSecrets(reason instanceof Error ? reason.message : String(reason), secrets))
      } finally {
        clearTimeout(timer)
        context.signal.removeEventListener('abort', onAbort)
      }
    },
  }
}
