import type { LlmAdapter, LlmRequest, LlmResponse } from '@open-agent/agent'

/** Status codes worth retrying against a different provider. */
const FALLBACKABLE_CODES = new Set([401, 403, 429])

/** Resolves once `ms` has elapsed, or rejects as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Pulls an HTTP status out of a provider error message. Prefers the explicit
 * `responded NNN` shape the SDK adapters emit; otherwise accepts a standalone
 * 4xx/5xx token. Deliberately not a substring test — a bare `includes('429')`
 * matches request IDs and token counts, misrouting errors that are not rate limits.
 */
function parseStatusCode(msg: string): number | null {
  const explicit = msg.match(/responded (\d{3})/)
  if (explicit) return Number.parseInt(explicit[1], 10)
  const standalone = msg.match(/\b([45]\d{2})\b/)
  if (standalone) return Number.parseInt(standalone[1], 10)
  return null
}

export interface FallbackAdapterOptions {
  adapters: LlmAdapter[]
  notify?: (msg: string) => void
}

export class ProviderFallbackAdapter implements LlmAdapter {
  readonly name = 'provider-fallback'

  constructor(private readonly opts: FallbackAdapterOptions) {}

  async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    const adapters = this.opts.adapters
    if (adapters.length === 0) throw new Error('no providers in fallback')

    // Rotation is intentionally stateless: every call starts at the first
    // adapter. A shared mutable cursor races under concurrent generate() calls,
    // so preferred-provider order is re-derived per call instead.
    let delay = 0
    let lastError: unknown
    for (let i = 0; i < adapters.length; i++) {
      const adapter = adapters[i]
      if (signal.aborted) throw signal.reason ?? new Error('aborted')
      if (delay > 0) await sleep(delay, signal)
      try {
        const res = await adapter.generate(request, signal)
        // Only report a switch when one actually happened — i.e. the adapter
        // that answered is not the one this call started with.
        if (i > 0) {
          this.notify(`switched from ${adapters[0].name} to ${adapter.name}`)
        }
        return res
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // 400 is excluded: it indicates a client fault (bad request body, missing
        // fields) that a fallback provider will also produce — rotating is wasted.
        // 401/403/429 indicate transient or auth problems worth retrying elsewhere.
        const code = parseStatusCode(msg)
        if (code !== null && FALLBACKABLE_CODES.has(code)) {
          lastError = err
          this.notify(`provider ${adapter.name} failed (${msg}), trying fallback`)
          delay = Math.min(delay * 2 + 100, 5_000) // simple exponential backoff, capped at 5s
          continue
        }
        throw err
      }
    }
    // Carry the final provider error as `cause`. Without it a single misconfigured
    // adapter reports "all providers exhausted", which reads as rate limiting and
    // hides the actual 401 from a bad API key.
    throw new Error('all providers exhausted', { cause: lastError })
  }

  private notify(msg: string) {
    if (this.opts.notify) this.opts.notify(msg)
  }
}
