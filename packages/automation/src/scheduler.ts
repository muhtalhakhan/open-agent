import { randomBytes } from 'node:crypto'
import type { Logger } from '@open-agent/agent'
import { silentLogger } from '@open-agent/agent'
import { builtinTriggers } from './triggers.js'
import { parseCron } from './cron.js'
import { MemoryTaskStore } from './store.js'
import { parseInterval, parseWhen } from './when.js'
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
  /**
   * How stale a fire time may be and still be worth running, in milliseconds.
   *
   * Catching up on a missed run is usually right — that is the whole point of
   * a durable schedule — but not indefinitely: "post the Friday summary",
   * fired the following Wednesday because a laptop was shut, is worse than not
   * posting it. Defaults to `Infinity`, which always catches up.
   */
  graceMs?: number
}

/** Shared shape of `every()` and `cron()`. */
export interface RecurringTaskInput {
  name: string
  prompt: string
  /** IANA zone for wall-clock schedules and for reading `until`. */
  timeZone?: string
  /** Stop recurring after this instant, or any phrasing `parseWhen` accepts. */
  until?: string | number
  /** Stop after this many runs. */
  maxRuns?: number
  id?: string
}

/** What `once()` needs beyond the task itself. */
export interface OnceTaskInput {
  name: string
  prompt: string
  /** Any form `parseWhen` accepts, or an epoch-millisecond instant. */
  when: string | number
  /** IANA zone the wall-clock forms are read in (default: the host's zone). */
  timeZone?: string
  id?: string
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
  private readonly graceMs: number

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
    this.graceMs = options.graceMs ?? Infinity
  }

  /** The scheduler's clock, so callers resolve times against the same one. */
  currentTime(): number {
    return this.now()
  }

  /**
   * Schedules a task to run once, at a time written the way a person would
   * write it — "tomorrow at 9am", "in 30 minutes", "2026-09-10T09:00:00Z".
   *
   * The instant is resolved once, at add time, and stored. A one-time task
   * means a fixed moment, so re-resolving "tomorrow at 9am" on every restart
   * would quietly move the task instead of keeping it.
   */
  async once(input: OnceTaskInput): Promise<ScheduledTask> {
    const at =
      typeof input.when === 'number' ? input.when : parseWhen(input.when, { now: this.now(), timeZone: input.timeZone })

    return this.add({
      id: input.id,
      name: input.name,
      prompt: input.prompt,
      trigger: { kind: 'at', at },
    })
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

  /**
   * Schedules a task to repeat on a fixed interval — `'1h'`, `'30 minutes'`,
   * or milliseconds.
   *
   * Without an `anchor` the interval runs from each fire; with one,
   * occurrences are pinned to a grid from that instant, so an hourly task
   * anchored to the top of the hour stays on the hour across a restart.
   */
  async every(
    input: RecurringTaskInput & { interval: string | number; anchor?: string | number },
  ): Promise<ScheduledTask> {
    return this.add({
      id: input.id,
      name: input.name,
      prompt: input.prompt,
      maxRuns: input.maxRuns,
      trigger: {
        kind: 'every',
        everyMs: parseInterval(input.interval),
        ...(input.anchor === undefined ? {} : { anchor: this.resolveInstant(input.anchor, input.timeZone) }),
        ...(input.until === undefined ? {} : { until: this.resolveInstant(input.until, input.timeZone) }),
      },
    })
  }

  /**
   * Schedules a task on a crontab expression — `'0 9 * * 1-5'`, `'@daily'`.
   *
   * Fire times are wall-clock in `timeZone`, so `0 9 * * *` stays 9am through
   * a DST change rather than drifting an hour.
   */
  async cron(input: RecurringTaskInput & { expr: string }): Promise<ScheduledTask> {
    // Parse eagerly so a bad expression is rejected here, by the caller who
    // can still fix it, rather than silently at some later fire time.
    parseCron(input.expr)

    return this.add({
      id: input.id,
      name: input.name,
      prompt: input.prompt,
      maxRuns: input.maxRuns,
      trigger: {
        kind: 'cron',
        expr: input.expr,
        ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
        ...(input.until === undefined ? {} : { until: this.resolveInstant(input.until, input.timeZone) }),
      },
    })
  }

  /** Accepts either an instant or any phrasing `parseWhen` understands. */
  private resolveInstant(value: string | number, timeZone?: string): number {
    return typeof value === 'number' ? value : parseWhen(value, { now: this.now(), timeZone })
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
      maxRuns: input.maxRuns,
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
    const ready = [...this.tasks.values()].filter(
      (task) =>
        task.status === 'pending' &&
        task.nextRunAt !== undefined &&
        task.nextRunAt <= at &&
        !this.inFlight.has(task.id),
    )

    const stale = ready.filter((task) => at - task.nextRunAt! > this.graceMs)
    for (const task of stale) this.skipStale(task, at)
    if (stale.length > 0) await this.persist()

    const due = ready.filter((task) => !stale.includes(task))
    await Promise.all(due.map((task) => this.fire(task, at)))
    this.arm()
  }

  /**
   * Steps a task past every fire time older than the grace window without
   * running any of them.
   *
   * A recurring task lands on its next occurrence still in the window and
   * carries on; a one-time task runs out of occurrences and ends as `missed`.
   * The loop is bounded because a malformed evaluator that never advances
   * would otherwise spin forever.
   */
  private skipStale(task: ScheduledTask, at: number): void {
    let cursor = task.nextRunAt
    let skipped = 0

    for (let guard = 0; cursor !== undefined && at - cursor > this.graceMs && guard < 10_000; guard++) {
      let next: number | undefined
      try {
        next = this.evaluate(task.trigger, cursor, cursor)
      } catch (err) {
        task.lastError = err instanceof Error ? err.message : String(err)
        next = undefined
      }
      // An evaluator that will not move forward would loop forever; treat it
      // as having no further occurrences rather than hanging the scheduler.
      if (next !== undefined && next <= cursor) next = undefined
      cursor = next
      skipped++
    }

    task.missedCount = (task.missedCount ?? 0) + skipped
    task.nextRunAt = cursor
    task.status = cursor === undefined ? 'missed' : 'pending'
    this.logger.warn('scheduler/missed', { id: task.id, skipped, nextRunAt: cursor })
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

      // A run budget outranks the trigger: "every hour, five times" stops at
      // five whatever the trigger would offer next.
      if (task.maxRuns !== undefined && task.runCount >= task.maxRuns) nextRunAt = undefined

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
