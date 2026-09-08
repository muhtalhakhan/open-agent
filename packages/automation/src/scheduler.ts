import { randomBytes } from 'node:crypto'
import type { Logger } from '@open-agent/agent'
import { silentLogger } from '@open-agent/agent'
import { builtinTriggers } from './triggers.js'
import { MemoryTaskStore } from './store.js'
import type { NewTask, ScheduledTask, TaskRunner, TaskStatus, TaskStore, TriggerEvaluator } from './types.js'

/**
 * `setTimeout` stores its delay in a signed 32-bit int; anything larger
 * overflows and fires immediately. A task scheduled a month out is perfectly
 * ordinary, so long waits are armed in chunks of at most this much and
 * re-armed on each wake.
 */
const MAX_TIMER_DELAY = 2_147_483_647

type TimerHandle = unknown

export interface SchedulerOptions {
  /** Executes a task when it fires. */
  runner: TaskRunner
  /** Where the schedule is persisted (default: in memory). */
  store?: TaskStore
  /** Extra trigger kinds, merged over the built-ins. */
  triggers?: Record<string, TriggerEvaluator>
  logger?: Logger
  /** Clock source, injectable so tests can drive time by hand. */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

/** Narrows `list()` to part of the schedule. */
export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
}

/**
 * The time-driven half of automation: it owns the schedule, decides *when*
 * each entry is due, and hands it to a `TaskRunner`. It deliberately knows
 * nothing about what running a task means — no agent loop, no queue, no
 * process management — so the job queue (#80) and background execution (#79)
 * can supply those without the scheduler changing.
 *
 * Time enters only through the injected `now`/`setTimer`/`clearTimer` seam, so
 * a test can fire a month-long schedule in a millisecond and assert on exactly
 * which tasks ran.
 */
export class Scheduler {
  private readonly runner: TaskRunner
  private readonly store: TaskStore
  private readonly triggers: Map<string, TriggerEvaluator>
  private readonly logger: Logger
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void

  private readonly tasks = new Map<string, ScheduledTask>()
  /** Tasks whose runner is in flight, so a slow run is never started twice. */
  private readonly inFlight = new Map<string, Promise<void>>()
  private timer: TimerHandle | undefined
  private controller: AbortController | undefined
  private running = false

  constructor(options: SchedulerOptions) {
    this.runner = options.runner
    this.store = options.store ?? new MemoryTaskStore()
    this.triggers = new Map(Object.entries({ ...builtinTriggers, ...options.triggers }))
    this.logger = options.logger ?? silentLogger
    this.now = options.now ?? (() => Date.now())
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms)
        // A pending schedule should not by itself keep the process alive.
        handle.unref?.()
        return handle
      })
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  /**
   * Teaches the scheduler a trigger kind. Returns a disposer, so a plugin that
   * contributes a trigger takes it away again when it unmounts.
   */
  registerTrigger(kind: string, evaluator: TriggerEvaluator): () => void {
    if (this.triggers.has(kind)) throw new Error(`trigger kind "${kind}" is already registered`)
    this.triggers.set(kind, evaluator)
    return () => {
      if (this.triggers.get(kind) === evaluator) this.triggers.delete(kind)
    }
  }

  /** Reads the persisted schedule back into memory, replacing what is held. */
  async load(): Promise<void> {
    const stored = await this.store.load()
    this.tasks.clear()
    for (const task of stored) {
      // A task left `running` by a crash never got its completion recorded.
      // Put it back to `pending` so its stored fire time is honoured rather
      // than leaving an entry the scheduler will skip forever.
      this.tasks.set(task.id, task.status === 'running' ? { ...task, status: 'pending' } : { ...task })
    }
  }

  /** Loads the schedule and begins firing due tasks. Idempotent. */
  async start(): Promise<void> {
    if (this.running) return
    await this.load()
    this.running = true
    this.controller = new AbortController()
    this.logger.info('scheduler/start', { tasks: this.tasks.size })
    await this.tick()
  }

  /**
   * Stops firing and cancels in-flight runs, waiting for them to settle so a
   * stopped scheduler has no work still touching the store.
   */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.disarm()
    this.controller?.abort()
    this.controller = undefined
    await Promise.allSettled([...this.inFlight.values()])
    this.logger.info('scheduler/stop', {})
  }

  /** Adds a task and computes its first fire time. */
  async add(input: NewTask): Promise<ScheduledTask> {
    const id = input.id ?? `task_${randomBytes(6).toString('hex')}`
    if (this.tasks.has(id)) throw new Error(`task "${id}" already exists`)

    const createdAt = this.now()
    const nextRunAt = this.evaluate(input.trigger, createdAt, undefined)
    const task: ScheduledTask = {
      id,
      name: input.name,
      prompt: input.prompt,
      trigger: input.trigger,
      status: nextRunAt === undefined ? 'done' : 'pending',
      createdAt,
      nextRunAt,
      runCount: 0,
    }

    this.tasks.set(id, task)
    await this.persist()
    this.logger.info('scheduler/add', { id, name: task.name, nextRunAt })
    if (this.running) await this.tick()
    return { ...task }
  }

  /** Removes a task from the schedule for good. */
  async cancel(id: string): Promise<ScheduledTask | undefined> {
    return this.transition(id, 'cancelled', (task) => {
      task.nextRunAt = undefined
    })
  }

  /** Keeps a task but stops it firing until `resume()`. */
  async pause(id: string): Promise<ScheduledTask | undefined> {
    return this.transition(id, 'paused')
  }

  /**
   * Puts a paused task back in line. Its fire time is recomputed from now, so
   * a recurring task resumed after a long pause does not immediately fire once
   * for every occurrence it slept through.
   */
  async resume(id: string): Promise<ScheduledTask | undefined> {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'paused') return undefined
    const from = this.now()
    task.nextRunAt = this.evaluate(task.trigger, from, task.lastRunAt)
    task.status = task.nextRunAt === undefined ? 'done' : 'pending'
    await this.persist()
    this.logger.info('scheduler/resume', { id, nextRunAt: task.nextRunAt })
    if (this.running) await this.tick()
    return { ...task }
  }

  get(id: string): ScheduledTask | undefined {
    const task = this.tasks.get(id)
    return task && { ...task }
  }

  /** The schedule, soonest fire time first; entries that never fire go last. */
  list(filter: TaskFilter = {}): ScheduledTask[] {
    const wanted = filter.status === undefined ? undefined : new Set([filter.status].flat())
    return [...this.tasks.values()]
      .filter((task) => wanted === undefined || wanted.has(task.status))
      .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.createdAt - b.createdAt)
      .map((task) => ({ ...task }))
  }

  /**
   * Fires everything due, then arms the timer for whatever is next. Safe to
   * call by hand — that is how tests advance the schedule without real timers.
   */
  async tick(): Promise<void> {
    const at = this.now()
    const due = [...this.tasks.values()].filter(
      (task) =>
        task.status === 'pending' &&
        task.nextRunAt !== undefined &&
        task.nextRunAt <= at &&
        !this.inFlight.has(task.id),
    )

    await Promise.all(due.map((task) => this.fire(task, at)))
    this.arm()
  }

  /** Runs one task and re-arms it from the outcome. */
  private async fire(task: ScheduledTask, firedAt: number): Promise<void> {
    task.status = 'running'
    await this.persist()

    const signal = this.controller?.signal ?? new AbortController().signal
    const run = (async () => {
      let error: string | undefined
      try {
        await this.runner({ task: { ...task }, firedAt }, signal)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        this.logger.error('scheduler/run-failed', { id: task.id, error })
      }

      task.lastRunAt = firedAt
      task.runCount += 1
      task.lastError = error

      // Re-arm from the fire time, not from "now" — a run that took ten
      // minutes should not push an hourly task ten minutes later every time.
      let nextRunAt: number | undefined
      try {
        nextRunAt = this.evaluate(task.trigger, firedAt, firedAt)
      } catch (err) {
        task.lastError = err instanceof Error ? err.message : String(err)
        this.logger.error('scheduler/rearm-failed', { id: task.id, error: task.lastError })
      }

      task.nextRunAt = nextRunAt
      task.status = nextRunAt !== undefined ? 'pending' : task.lastError ? 'failed' : 'done'
      await this.persist()
      this.logger.info('scheduler/ran', { id: task.id, status: task.status, nextRunAt })
    })()

    this.inFlight.set(task.id, run)
    try {
      await run
    } finally {
      this.inFlight.delete(task.id)
    }
  }

  /** Shared body of `pause`/`cancel`: move a live task to a terminal-ish state. */
  private async transition(
    id: string,
    status: TaskStatus,
    mutate?: (task: ScheduledTask) => void,
  ): Promise<ScheduledTask | undefined> {
    const task = this.tasks.get(id)
    if (!task) return undefined
    task.status = status
    mutate?.(task)
    await this.persist()
    this.disarm()
    this.arm()
    this.logger.info(`scheduler/${status}`, { id })
    return { ...task }
  }

  private evaluate(trigger: ScheduledTask['trigger'], from: number, lastRunAt: number | undefined): number | undefined {
    const evaluator = this.triggers.get(trigger.kind)
    if (!evaluator) throw new Error(`unknown trigger kind "${trigger.kind}"`)
    return evaluator(trigger, from, lastRunAt)
  }

  /** Sets one timer for the soonest pending task. */
  private arm(): void {
    this.disarm()
    if (!this.running) return

    const next = this.list({ status: 'pending' }).find((task) => task.nextRunAt !== undefined)?.nextRunAt
    if (next === undefined) return

    const delay = Math.min(Math.max(next - this.now(), 0), MAX_TIMER_DELAY)
    this.timer = this.setTimer(() => {
      this.timer = undefined
      void this.tick().catch((err) => {
        this.logger.error('scheduler/tick-failed', { error: err instanceof Error ? err.message : String(err) })
      })
    }, delay)
  }

  private disarm(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
  }

  private async persist(): Promise<void> {
    await this.store.save([...this.tasks.values()].map((task) => ({ ...task })))
  }
}
