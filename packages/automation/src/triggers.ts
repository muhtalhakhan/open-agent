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

/** The trigger kinds every scheduler understands out of the box. */
export const builtinTriggers: Record<string, TriggerEvaluator> = {
  at: atTrigger,
}
