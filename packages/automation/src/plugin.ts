import type { Context, Plugin } from '@open-agent/context'
import { Scheduler, type SchedulerOptions } from './scheduler.js'

/**
 * Mounts `ctx.scheduler`.
 *
 * The scheduler is not started here. Mounting registers the seam so other
 * plugins can find it; starting it fires tasks, which is a decision for
 * whoever owns the process lifetime (the CLI, the future daemon) rather than a
 * side effect of wiring the context up.
 */
export function schedulerPlugin(options: SchedulerOptions): Plugin {
  return {
    name: 'scheduler',
    apply(ctx: Context) {
      const scheduler = new Scheduler(options)
      ctx.set('scheduler', scheduler)
      return () => {
        void scheduler.stop()
      }
    },
  }
}
