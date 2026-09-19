import type { Context, Plugin } from '@open-agent/context'
import type { AgentLoop, SessionLog } from '@open-agent/agent'
import { Scheduler, type SchedulerOptions } from './scheduler.js'
import { JobQueue, agentExecutor, type JobQueueOptions } from './queue.js'

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

/**
 * Mounts `ctx.jobQueue`, running each job as a turn of `ctx.agentLoop` and
 * taking its result from `ctx.sessions`.
 *
 * Waits on `agentLoop` through `inject` rather than reading it at mount time,
 * so the order the two plugins are mounted in does not matter. Pass
 * `jobQueue.runner()` as the scheduler's runner to send fired tasks through it.
 */
export function jobQueuePlugin(options: Omit<JobQueueOptions, 'executor'> = {}): Plugin {
  return {
    name: 'jobQueue',
    inject: ['agentLoop', 'sessions'],
    apply(ctx: Context) {
      const executor = agentExecutor(ctx.get<AgentLoop>('agentLoop')!, ctx.get<SessionLog>('sessions')!)
      const queue = new JobQueue({ ...options, executor })
      ctx.set('jobQueue', queue)
      return () => {
        void queue.close()
      }
    },
  }
}
