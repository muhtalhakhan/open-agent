import type { Logger } from '@open-agent/agent'
import { redactSecrets } from './errors.js'

/**
 * Wraps a `Logger` so that no configured secret can reach it, whatever a
 * provider or tool decides to log.
 *
 * `redactUrl` already covers credentials that travel as query parameters, but
 * a key sent as a header shows up in other places entirely — a provider
 * echoing the request back in an error body, a tool logging the arguments it
 * was called with. Filtering at the logger catches all of them at once, so a
 * new call site cannot forget.
 */
export function createRedactingLogger(logger: Logger, secrets: Iterable<string>): Logger {
  const values = [...secrets]
  if (values.length === 0) return logger

  const scrub = (event: string, data?: Record<string, unknown>) =>
    [
      redactSecrets(event, values),
      data === undefined ? undefined : (walk(data, values, new WeakSet()) as Record<string, unknown>),
    ] as const

  return {
    info: (event, data) => logger.info(...scrub(event, data)),
    warn: (event, data) => logger.warn(...scrub(event, data)),
    error: (event, data) => logger.error(...scrub(event, data)),
  }
}

/**
 * Recurses through arrays and plain objects only. A class instance — an
 * `Error`, a `URL` — keeps its interesting state on the prototype or in
 * non-enumerable fields, so rebuilding it from `Object.entries` would quietly
 * destroy it; those are passed through and left to the logger's own
 * serialisation. The `seen` set keeps a cyclic structure from hanging the
 * process before it ever reaches the log.
 */
function walk(value: unknown, secrets: string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSecrets(value, secrets)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => walk(item, secrets, seen))

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, secrets, seen)]))
}
