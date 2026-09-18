import { randomBytes } from 'node:crypto'
import type { AgentLoop, Logger } from '@open-agent/agent'
import { CancelledError, silentLogger } from '@open-agent/agent'
import type { TaskRunner } from './types.js'

/** Lifecycle of a queued job. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** One unit of work waiting for, or holding, an execution slot. */
export interface Job {
  id: string
  name: string
  prompt: string
  status: JobStatus
  enqueuedAt: number
  startedAt?: number
  finishedAt?: number
  /** Why the job failed, when it did. */
  error?: string
  /** The scheduled task this job was fired from, if any. */
  source?: { taskId: string; firedAt: number }
}

/** What `enqueue()` needs; everything else is derived. */
export interface NewJob {
  name: string
  prompt: string
  id?: string
  source?: Job['source']
}

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
  logger?: Logger
  now?: () => number
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
  private readonly logger: Logger
  private readonly now: () => number

  private readonly jobs = new Map<string, Job>()
  private readonly waiting: Job[] = []
  private readonly controllers = new Map<string, AbortController>()
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
    this.logger = options.logger ?? silentLogger
    this.now = options.now ?? (() => Date.now())
  }

  /** Adds a job to the back of the line, starting it at once if a slot is free. */
  enqueue(input: NewJob): Job {
    if (this.closed) throw new Error('job queue is closed')
    const id = input.id ?? `job_${randomBytes(6).toString('hex')}`
    if (this.jobs.has(id)) throw new Error(`job "${id}" already exists`)

    const job: Job = {
      id,
      name: input.name,
      prompt: input.prompt,
      status: 'queued',
      enqueuedAt: this.now(),
      ...(input.source ? { source: input.source } : {}),
    }
    this.jobs.set(id, job)
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
    } else {
      this.controllers.get(id)?.abort()
    }
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
   * task's `lastError`.
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
    this.logger.info('queue/start', { id: job.id })

    try {
      await this.executor({ ...job }, controller.signal)
      this.settle(job, 'succeeded')
    } catch (err) {
      if (controller.signal.aborted) this.settle(job, 'cancelled')
      else this.settle(job, 'failed', err instanceof Error ? err.message : String(err))
    } finally {
      this.controllers.delete(job.id)
      this.pump()
    }
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
    for (const job of finished.slice(0, Math.max(0, finished.length - this.historyLimit))) this.jobs.delete(job.id)
  }
}

/**
 * Runs each job as an agent turn. The job id doubles as the task id, so a
 * job's transcript is found in the session log under the same id the queue
 * reports.
 *
 * `AgentLoop.run` reports failure and cancellation as a status rather than by
 * throwing; this turns them back into the throw the queue reads outcomes from.
 */
export function agentExecutor(loop: Pick<AgentLoop, 'run'>): JobExecutor {
  return async (job, signal) => {
    const state = await loop.run(job.prompt, signal, job.id)
    if (state.status === 'cancelled') throw new CancelledError()
    if (state.status === 'error') throw new Error(state.error ?? 'agent run failed')
  }
}
