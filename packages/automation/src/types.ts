/** Lifecycle of a scheduled task. */
export type TaskStatus =
  /** Waiting for its next fire time. */
  | 'pending'
  /** The runner is executing it right now. */
  | 'running'
  /** Fired for the last time and will never fire again. */
  | 'done'
  /** Its last run threw and it has no further fire times. */
  | 'failed'
  /** Kept in the schedule but skipped until resumed. */
  | 'paused'
  /** Its fire time passed by more than the grace window, so it was not run. */
  | 'missed'
  /** Removed from the schedule by hand. */
  | 'cancelled'

/**
 * When a task fires. The scheduler itself only understands `kind` — each kind
 * is given meaning by a `TriggerEvaluator` registered under that name, so
 * one-time (#77) and recurring (#78) triggers plug in without the scheduler
 * learning about calendars or cron syntax.
 */
export interface TriggerSpec {
  kind: string
  [field: string]: unknown
}

/** Fires once, at an absolute epoch-millisecond timestamp. */
export interface AtTrigger extends TriggerSpec {
  kind: 'at'
  at: number
}

/**
 * Computes the next time a trigger fires, in epoch milliseconds, or
 * `undefined` when it will never fire again.
 *
 * `from` is the moment being scheduled from — the current time on `add()`, and
 * the fire time on a re-arm — and `lastRunAt` is when the task last fired, so
 * an interval trigger can space runs from the previous one. An evaluator must
 * be pure: the scheduler calls it whenever it needs to re-derive a fire time,
 * including after a restart.
 */
export type TriggerEvaluator = (spec: TriggerSpec, from: number, lastRunAt?: number) => number | undefined

/** One entry in the schedule. */
export interface ScheduledTask {
  id: string
  /** Human-readable label, shown when listing the schedule. */
  name: string
  /** The agent prompt to run when this task fires. */
  prompt: string
  trigger: TriggerSpec
  status: TaskStatus
  createdAt: number
  /** When this task fires next, absent once it never will again. */
  nextRunAt?: number
  /** When it last fired. */
  lastRunAt?: number
  /** How many times it has fired. */
  runCount: number
  /** How many fire times were passed over as too stale to be worth running. */
  missedCount?: number
  /** The error from the most recent failed run, if any. */
  lastError?: string
  /** Stop after this many runs. Unbounded when absent. */
  maxRuns?: number
}

/** What `schedule.add()` needs; everything else is derived. */
export interface NewTask {
  name: string
  prompt: string
  trigger: TriggerSpec
  /** Provide an id to make `add()` idempotent; one is generated otherwise. */
  id?: string
  /** Stop after this many runs. Unbounded when absent. */
  maxRuns?: number
}

/** Handed to the runner when a task fires. */
export interface TaskDispatch {
  task: ScheduledTask
  /** The scheduler's clock reading for this fire, not `Date.now()`. */
  firedAt: number
}

/**
 * Executes a fired task. The scheduler decides *when* work happens and never
 * *what* the work is: this seam is where the job queue (#80) and background
 * execution (#79) attach, and it is why the scheduler does not depend on the
 * agent loop.
 */
export type TaskRunner = (dispatch: TaskDispatch, signal: AbortSignal) => Promise<void>

/** Durable storage for the schedule. */
export interface TaskStore {
  load(): Promise<ScheduledTask[]>
  save(tasks: ScheduledTask[]): Promise<void>
}
