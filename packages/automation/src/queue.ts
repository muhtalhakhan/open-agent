import { randomBytes } from 'node:crypto'
import type { AgentLoop, Logger } from '@open-agent/agent'
import { CancelledError, silentLogger } from '@open-agent/agent'
import type { TaskRunner } from './types.js'

/** Lifecycle of a queued job. */
export type JobStatus =
  | 'queued'
  | 'running'
  /** An attempt failed and the job is waiting out its backoff before the next. */
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

/** One unit of work waiting for, or holding, an execution slot. */
export interface Job {
  id: string
  name: string
  prompt: string
  status: JobStatus
  enqueuedAt: number
  startedAt?: number
  finishedAt?: number
  /** Why the most recent attempt failed. Cleared if a later attempt succeeds. */
  error?: string
  /** Attempts started so far, including one in progress. */
  attempts: number
  /** Attempts allowed before the job is given up as `failed`. */
  maxAttempts: number
  /** When the next attempt is due, while the job is `retrying`. */
  retryAt?: number
  /** The scheduled task this job was fired from, if any. */
  source?: { taskId: string; firedAt: number }
}

/** What `enqueue()` needs; everything else is derived. */
export interface NewJob {
  name: string
  prompt: string
  id?: string
  source?: Job['source']
  /** Overrides the queue's retry policy for this job. */
  retry?: RetryPolicy
}

/**
 * When a failed job is worth another attempt.
 *
 * Off by default (`maxAttempts: 1`). An agent run is not idempotent: a run
 * that failed on step five had already made the tool calls of steps one to
 * four, and running it again makes them again. Turn retries on for work where
 * that is harmless, and use `retryable` to retry only the failures a second
 * attempt can fix — a rate limit, not a malformed prompt.
 */
export interface RetryPolicy {
  /** Total attempts, counting the first (default 1: never retry). */
  maxAttempts?: number
  /** Wait before the first retry, doubling for each one after (default 1000 ms). */
  backoffMs?: number
  /** Ceiling on that wait (default 60 000 ms). */
  maxBackoffMs?: number
  /** Whether a failure is worth retrying, given its message (default: every failure). */
  retryable?: (error: string) => boolean
}

type ResolvedRetryPolicy = Required<RetryPolicy>

type TimerHandle = unknown

/**
 * Does the work of one job. Resolving means it succeeded; throwing means it
 * failed — or, if the signal was aborted first, that it was cancelled.
 */
export type JobExecutor = (job: Job, signal: AbortSignal) => Promise<void>

export interface JobQueueOptions {
  executor: JobExecutor
  /**
   * How many jobs may run at once (default 1). Serial by default because an
   * agent run can stop to ask for approval, and two runs prompting on the same
   * terminal at once interleave into something nobody can answer safely.
   */
  concurrency?: number
  /** How many finished jobs `list()` remembers before dropping the oldest (default 1000). */
  historyLimit?: number
  /** The default retry policy; a job's own `retry` is merged over it. */
  retry?: RetryPolicy
  logger?: Logger
  /** Clock and timers, injectable so tests can step through backoffs by hand. */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

/** Narrows `list()` to part of the queue. */
export interface JobFilter {
  status?: JobStatus | JobStatus[]
}

const FINISHED: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * Bounds how much work runs at once. The scheduler decides *when* a task is
 * due; the queue decides whether there is room to run it yet, and runs it in
 * arrival order when there is.
 *
 * The queue is deliberately in memory. Durability already lives in the
 * scheduler: a task whose job was still waiting here when the process died is
 * left `running` in the schedule, and the scheduler puts such tasks back to
 * `pending` on the next load — so it is fired again rather than lost, without
 * the queue keeping a second copy of the schedule on disk.
 */
export class JobQueue {
  private readonly executor: JobExecutor
  private readonly concurrency: number
  private readonly historyLimit: number
  private readonly retry: RetryPolicy
  private readonly logger: Logger
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void

  private readonly jobs = new Map<string, Job>()
  private readonly waiting: Job[] = []
  private readonly controllers = new Map<string, AbortController>()
  private readonly policies = new Map<string, ResolvedRetryPolicy>()
  private readonly backoffs = new Map<string, TimerHandle>()
  private readonly settled = new Map<string, Array<(job: Job) => void>>()
  private closed = false

  constructor(options: JobQueueOptions) {
    const concurrency = options.concurrency ?? 1
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`concurrency must be a positive integer, got ${concurrency}`)
    }
    this.executor = options.executor
    this.concurrency = concurrency
    this.historyLimit = options.historyLimit ?? 1000
    this.retry = options.retry ?? {}
    this.logger = options.logger ?? silentLogger
    this.now = options.now ?? (() => Date.now())
    // Not unref'd, unlike the scheduler's timer: a pending retry is work
    // someone may be awaiting, and letting the process exit under it would
    // leave that promise hanging forever.
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  /** Adds a job to the back of the line, starting it at once if a slot is free. */
  enqueue(input: NewJob): Job {
    if (this.closed) throw new Error('job queue is closed')
    const id = input.id ?? `job_${randomBytes(6).toString('hex')}`
    if (this.jobs.has(id)) throw new Error(`job "${id}" already exists`)

    const policy = resolvePolicy({ ...this.retry, ...input.retry })
    const job: Job = {
      id,
      name: input.name,
      prompt: input.prompt,
      status: 'queued',
      enqueuedAt: this.now(),
      attempts: 0,
      maxAttempts: policy.maxAttempts,
      ...(input.source ? { source: input.source } : {}),
    }
    this.jobs.set(id, job)
    this.policies.set(id, policy)
    this.waiting.push(job)
    this.logger.info('queue/enqueue', { id, name: job.name, waiting: this.waiting.length })
    this.pump()
    return { ...job }
  }

  get(id: string): Job | undefined {
    const job = this.jobs.get(id)
    return job && { ...job }
  }

  /** Jobs in arrival order. */
  list(filter: JobFilter = {}): Job[] {
    const wanted = filter.status === undefined ? undefined : new Set([filter.status].flat())
    return [...this.jobs.values()]
      .filter((job) => wanted === undefined || wanted.has(job.status))
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
      .map((job) => ({ ...job }))
  }

  /**
   * Cancels a job. A queued job is dropped straight away; a running one has
   * its signal aborted and becomes `cancelled` once its executor lets go —
   * the queue cannot stop work that ignores the signal, only ask.
   */
  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id)
    if (!job || FINISHED.has(job.status)) return undefined
    if (job.status === 'queued') {
      this.waiting.splice(this.waiting.indexOf(job), 1)
      this.settle(job, 'cancelled')
    } else if (job.status === 'retrying') {
      this.clearBackoff(job)
      this.settle(job, 'cancelled')
    } else {
      this.controllers.get(id)?.abort()
    }
    return { ...job }
  }

  /**
   * Gives a failed or cancelled job one more attempt, straight away and at the
   * back of the line. For a person deciding a failure was transient; automatic
   * retries are the `retry` policy's job.
   *
   * A job that came from the schedule has already been reported back to the
   * scheduler as failed, so a manual retry does not change the task's record.
   */
  retryNow(id: string): Job | undefined {
    if (this.closed) throw new Error('job queue is closed')
    const job = this.jobs.get(id)
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return undefined
    job.maxAttempts = job.attempts + 1
    job.status = 'queued'
    job.finishedAt = undefined
    this.waiting.push(job)
    this.logger.info('queue/retry-now', { id, attempt: job.attempts + 1 })
    this.pump()
    return { ...job }
  }

  /** Resolves with the job once it has finished, however it finished. */
  wait(id: string): Promise<Job> {
    const job = this.jobs.get(id)
    if (!job) return Promise.reject(new Error(`no job "${id}"`))
    if (FINISHED.has(job.status)) return Promise.resolve({ ...job })
    return new Promise((resolve) => {
      const waiters = this.settled.get(id) ?? []
      waiters.push(resolve)
      this.settled.set(id, waiters)
    })
  }

  /**
   * Stops taking work: queued jobs are cancelled, running ones are asked to
   * stop, and this resolves once they have.
   */
  async close(): Promise<void> {
    this.closed = true
    for (const job of this.waiting.splice(0)) this.settle(job, 'cancelled')
    for (const job of this.jobs.values()) {
      if (job.status !== 'retrying') continue
      this.clearBackoff(job)
      this.settle(job, 'cancelled')
    }
    const running = [...this.controllers.keys()]
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.all(running.map((id) => this.wait(id)))
  }

  /**
   * A `TaskRunner` that sends each fired task through this queue.
   *
   * It waits for the job to finish instead of returning once it is queued, so
   * the scheduler keeps its own guarantees: a task still in line is still
   * in flight and is not fired a second time, and a failed job surfaces as the
   * task's `lastError`. Retries happen inside that wait, so the scheduler only
   * hears about a failure once the job has run out of attempts.
   */
  runner(): TaskRunner {
    return async ({ task, firedAt }, signal) => {
      const job = this.enqueue({ name: task.name, prompt: task.prompt, source: { taskId: task.id, firedAt } })
      const onAbort = () => this.cancel(job.id)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      try {
        const done = await this.wait(job.id)
        if (done.status === 'failed') throw new Error(done.error)
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    }
  }

  private pump(): void {
    while (this.controllers.size < this.concurrency && this.waiting.length > 0) {
      void this.execute(this.waiting.shift()!)
    }
  }

  private async execute(job: Job): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    job.status = 'running'
    job.startedAt = this.now()
    job.attempts += 1
    this.logger.info('queue/start', { id: job.id, attempt: job.attempts })

    try {
      await this.executor({ ...job }, controller.signal)
      job.error = undefined
      this.settle(job, 'succeeded')
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (controller.signal.aborted) this.settle(job, 'cancelled')
      else if (this.shouldRetry(job, error)) this.backOff(job, error)
      else this.settle(job, 'failed', error)
    } finally {
      this.controllers.delete(job.id)
      this.pump()
    }
  }

  private shouldRetry(job: Job, error: string): boolean {
    const policy = this.policies.get(job.id)!
    if (this.closed || job.attempts >= job.maxAttempts) return false
    try {
      return policy.retryable(error)
    } catch {
      // A predicate that throws cannot vouch for the retry; fail the job
      // with its real error instead of losing it to the predicate's.
      return false
    }
  }

  /** Parks a failed job for its backoff, then puts it back at the end of the line. */
  private backOff(job: Job, error: string): void {
    const policy = this.policies.get(job.id)!
    const delay = Math.min(policy.backoffMs * 2 ** (job.attempts - 1), policy.maxBackoffMs)
    job.status = 'retrying'
    job.error = error
    job.retryAt = this.now() + delay
    this.logger.warn('queue/retrying', { id: job.id, attempt: job.attempts, delay, error })

    this.backoffs.set(
      job.id,
      this.setTimer(() => {
        this.backoffs.delete(job.id)
        job.retryAt = undefined
        job.status = 'queued'
        this.waiting.push(job)
        this.pump()
      }, delay),
    )
  }

  private clearBackoff(job: Job): void {
    const handle = this.backoffs.get(job.id)
    if (handle !== undefined) this.clearTimer(handle)
    this.backoffs.delete(job.id)
    job.retryAt = undefined
  }

  private settle(job: Job, status: JobStatus, error?: string): void {
    job.status = status
    job.finishedAt = this.now()
    if (error !== undefined) job.error = error
    if (status === 'failed') this.logger.error('queue/failed', { id: job.id, error })
    else this.logger.info(`queue/${status}`, { id: job.id })

    for (const resolve of this.settled.get(job.id) ?? []) resolve({ ...job })
    this.settled.delete(job.id)
    this.forgetOldest()
  }

  /** Drops the oldest finished jobs past `historyLimit`, so a long-lived queue does not grow forever. */
  private forgetOldest(): void {
    const finished = [...this.jobs.values()].filter((job) => FINISHED.has(job.status))
    for (const job of finished.slice(0, Math.max(0, finished.length - this.historyLimit))) {
      this.jobs.delete(job.id)
      this.policies.delete(job.id)
    }
  }
}

function resolvePolicy(policy: RetryPolicy): ResolvedRetryPolicy {
  const resolved = {
    maxAttempts: policy.maxAttempts ?? 1,
    backoffMs: policy.backoffMs ?? 1000,
    maxBackoffMs: policy.maxBackoffMs ?? 60_000,
    retryable: policy.retryable ?? (() => true),
  }
  if (!Number.isInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
    throw new Error(`maxAttempts must be a positive integer, got ${resolved.maxAttempts}`)
  }
  if (resolved.backoffMs < 0 || resolved.maxBackoffMs < 0) throw new Error('backoff must not be negative')
  return resolved
}

/**
 * Runs each job as an agent turn. The job id doubles as the task id, so a
 * job's transcript is found in the session log under the same id the queue
 * reports. A retry runs as `<job id>.<attempt>`: reusing the id would append
 * the prompt a second time to the failed attempt's conversation, and the
 * model would read it as the user repeating themselves.
 *
 * `AgentLoop.run` reports failure and cancellation as a status rather than by
 * throwing; this turns them back into the throw the queue reads outcomes from.
 */
export function agentExecutor(loop: Pick<AgentLoop, 'run'>): JobExecutor {
  return async (job, signal) => {
    const taskId = job.attempts > 1 ? `${job.id}.${job.attempts}` : job.id
    const state = await loop.run(job.prompt, signal, taskId)
    if (state.status === 'cancelled') throw new CancelledError()
    if (state.status === 'error') throw new Error(state.error ?? 'agent run failed')
  }
}
