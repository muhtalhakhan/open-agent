import { parseCron, nextCronTime, type CronFields } from './cron.js'
import type { AtTrigger, TriggerEvaluator, TriggerSpec } from './types.js'

/**
 * Fires once at `spec.at`, then never again.
 *
 * "Has it already fired?" is `lastRunAt`, not a comparison against the clock.
 * That distinction is what makes a missed run recoverable: a task whose `at`
 * fell while the process was down still has no `lastRunAt`, so it comes back
 * with a fire time in the past, is immediately due, and runs once on startup
 * instead of being silently skipped.
 */
export const atTrigger: TriggerEvaluator = (spec: TriggerSpec, _from: number, lastRunAt?: number) => {
  const at = (spec as AtTrigger).at
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    throw new Error(`"at" trigger needs a numeric \`at\` timestamp, got ${JSON.stringify(spec.at)}`)
  }
  return lastRunAt === undefined ? at : undefined
}

/** Reads an optional `until` bound off a spec. */
function untilBound(spec: TriggerSpec): number | undefined {
  const until = spec.until
  if (until === undefined) return undefined
  if (typeof until !== 'number' || !Number.isFinite(until)) {
    throw new Error(`\`until\` must be a timestamp, got ${JSON.stringify(until)}`)
  }
  return until
}

/** Drops a fire time that falls past the trigger's `until` bound. */
function withinBound(next: number | undefined, spec: TriggerSpec): number | undefined {
  const until = untilBound(spec)
  if (next === undefined || until === undefined) return next
  return next <= until ? next : undefined
}

/**
 * Fires on a fixed interval.
 *
 * Without an `anchor` the interval is measured from the previous fire, which
 * is what "every hour" usually means. With one, occurrences are pinned to a
 * grid running from that instant, so a task anchored to the top of the hour
 * keeps firing on the hour even after a restart lands it mid-interval.
 */
export const everyTrigger: TriggerEvaluator = (spec: TriggerSpec, from: number) => {
  const everyMs = spec.everyMs
  if (typeof everyMs !== 'number' || !Number.isFinite(everyMs) || everyMs <= 0) {
    throw new Error(`"every" trigger needs a positive \`everyMs\`, got ${JSON.stringify(everyMs)}`)
  }

  const anchor = spec.anchor
  if (anchor === undefined) return withinBound(from + everyMs, spec)

  if (typeof anchor !== 'number' || !Number.isFinite(anchor)) {
    throw new Error(`\`anchor\` must be a timestamp, got ${JSON.stringify(anchor)}`)
  }
  if (from < anchor) return withinBound(anchor, spec)

  // The first grid point strictly after `from`.
  const elapsed = from - anchor
  return withinBound(anchor + (Math.floor(elapsed / everyMs) + 1) * everyMs, spec)
}

/**
 * Parsed expressions are cached: an evaluator runs on every re-arm, and
 * re-parsing a string that cannot have changed is pure overhead.
 */
const cronCache = new Map<string, CronFields>()

function compileCron(expression: string): CronFields {
  const cached = cronCache.get(expression)
  if (cached) return cached
  const fields = parseCron(expression)
  cronCache.set(expression, fields)
  return fields
}

/**
 * Fires on a crontab schedule, read as wall-clock time in `spec.timeZone`
 * (default: the host's zone).
 *
 * Wall-clock is the point: `0 9 * * 1-5` means 9am on weekdays, and it has to
 * stay 9am when the clocks change rather than drifting to 8 or 10.
 */
export const cronTrigger: TriggerEvaluator = (spec: TriggerSpec, from: number) => {
  const expression = spec.expr
  if (typeof expression !== 'string') {
    throw new Error(`"cron" trigger needs an \`expr\` string, got ${JSON.stringify(expression)}`)
  }
  const timeZone = typeof spec.timeZone === 'string' ? spec.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone
  return withinBound(nextCronTime(compileCron(expression), from, timeZone), spec)
}

/** The trigger kinds every scheduler understands out of the box. */
export const builtinTriggers: Record<string, TriggerEvaluator> = {
  at: atTrigger,
  every: everyTrigger,
  cron: cronTrigger,
}
