import { ProviderHttpError } from './errors.js'
import type { LlmAdapter, LlmRequest, LlmResponse } from '@open-agent/agent'

/**
 * Statuses worth retrying against a different provider.
 *
 * 401/403/429 are auth and quota problems specific to one account. 408 is a
 * timeout and 502/503/504 mean that provider is down, which is the case a
 * fallback exists for. 529 is included because Anthropic — whose adapter ships
 * in this package — signals overload with `overloaded_error` at 529 rather
 * than 503, so omitting it would strand the primary during exactly the outage
 * this adapter absorbs.
 *
 * 400 and 500 are excluded: 400 is a client fault (malformed body, missing
 * field) the next provider will reject identically, and a bare 500 is
 * ambiguous enough that retrying elsewhere is as likely to mask a bug as to
 * route around one.
 */
const FALLBACKABLE_STATUSES = new Set([401, 403, 408, 429, 502, 503, 504, 529])

/**
 * Last-resort status extraction for errors that did not come from one of our
 * adapters (a custom `LlmAdapter`, say). Adapters in this package throw
 * `ProviderHttpError`, which carries the status directly and needs no parsing.
 *
 * Deliberately not a substring test — a bare `includes('429')` matches request
 * IDs and token counts, misrouting errors that are not rate limits.
 */
function parseStatusCode(msg: string): number | null {
  const explicit = msg.match(/responded (\d{3})/)
  if (explicit) return Number.parseInt(explicit[1], 10)
  const standalone = msg.match(/\b([45]\d{2})\b/)
  if (standalone) return Number.parseInt(standalone[1], 10)
  return null
}

function statusOf(err: unknown): number | null {
  if (err instanceof ProviderHttpError) return err.status
  return parseStatusCode(err instanceof Error ? err.message : String(err))
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
    //
    // There is deliberately no delay between adapters either. Backoff waits out
    // a rate limit, but the next adapter is a different provider with its own
    // quota — it is not throttled because this one is, so sleeping before
    // switching would add latency and relieve nothing.
    let lastError: unknown
    for (let i = 0; i < adapters.length; i++) {
      const adapter = adapters[i]
      if (signal.aborted) throw signal.reason ?? new Error('aborted')
      try {
        const res = await adapter.generate(request, signal)
        // Only report a switch when one actually happened — i.e. the adapter
        // that answered is not the one this call started with.
        if (i > 0) {
          this.notify(`switched from ${adapters[0].name} to ${adapter.name}`)
        }
        return res
      } catch (err) {
        const status = statusOf(err)
        if (status !== null && FALLBACKABLE_STATUSES.has(status)) {
          lastError = err
          const msg = err instanceof Error ? err.message : String(err)
          this.notify(`provider ${adapter.name} failed (${msg}), trying fallback`)
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
